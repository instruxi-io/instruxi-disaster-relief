// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainlinkCREClient} from "./utils/ChainlinkCREClient.sol";
import {IReliefTreasury} from "./interfaces/IReliefTreasury.sol";

/**
 * @title ReliefTreasury
 * @notice CRE-Orchestrated Disaster Relief Distribution Treasury
 *
 * @dev Architecture:
 *   - Holds USDC and is the final enforcement point for all monetary safety guarantees.
 *   - Inherits ChainlinkCREClient to emit RequestSent events (request side).
 *   - Implements onReport() as the CRE write target (fulfill side via Chainlink Forwarder).
 *   - No offchain component — including Chainlink CRE — can over-transfer funds or
 *     bypass onchain invariants.
 *
 * Two CRE request types:
 *   1. "event_verification" — CRE queries USGS/GDACS/ReliefWeb (2-of-3 rule) and
 *      calls back with verified=true/false.
 *   2. "disbursement" — Recipient pulls funds; CRE validates via OPA policy and
 *      Instruxi Enforcer group membership, then calls back with (allowed, tier).
 *
 * Governance model:
 *   - DEFAULT_ADMIN_ROLE should be held by the funding organization (charity/NGO),
 *     not the platform operator. The deployer should transfer this role immediately
 *     after deploy in production.
 *   - Tier amounts are committed at event registration time and cannot be changed.
 *     This is the onchain transparency guarantee: the funding org locks in what
 *     each tier pays before any roster is processed or any claim is made.
 *   - Roster hash anchoring (anchorRoster) provides auditability for offchain
 *     tier assignments: anyone can hash the original CSV and verify it matches
 *     the onchain RosterAnchored event.
 *
 * Enforced invariants (all onchain, cannot be bypassed):
 *   - No payout unless event is Active (verified by CRE)
 *   - No payout for an unconfigured tier (TierNotConfigured)
 *   - No payout above per-event cap
 *   - No payout above program cap
 *   - No double payment per event per recipient
 *   - Only authorized fulfillers can fulfill requests
 *
 * CRE Report Encoding (prefix byte routes the report):
 *   0x01 = event_verification result: abi.encode(bytes32 requestId, bool verified)
 *   0x02 = disbursement result:       abi.encode(bytes32 requestId, bool allowed, uint8 tier)
 */
contract ReliefTreasury is IReliefTreasury, ChainlinkCREClient, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ================================================================
    //                           ROLES
    // ================================================================

    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");
    bytes32 public constant PAUSER_ROLE    = keccak256("PAUSER_ROLE");


    // ================================================================
    //                    REQUEST TYPE CONSTANTS
    // ================================================================

    string public constant REQUEST_TYPE_EVENT_VERIFICATION = "event_verification";
    string public constant REQUEST_TYPE_DISBURSEMENT        = "disbursement";

    /// @dev Pre-computed keccak256 hashes used for O(1) type dispatch
    bytes32 private constant _HASH_EVENT_VERIFICATION = keccak256("event_verification");
    bytes32 private constant _HASH_DISBURSEMENT        = keccak256("disbursement");

    /// @dev Report prefix bytes (first byte of onReport payload)
    uint8 private constant _REPORT_EVENT_VERIFICATION = 0x01;
    uint8 private constant _REPORT_DISBURSEMENT        = 0x02;

    // ================================================================
    //                         IMMUTABLES
    // ================================================================

    /// @notice The USDC token held and disbursed by this treasury
    IERC20 public immutable usdc;

    /// @notice Hard ceiling for any single disbursement (6 decimals).
    ///         Enforced at event registration: no tier amount may exceed this value.
    uint256 public immutable perRecipientCap;

    /// @notice Maximum total USDC disbursable across the entire program (6 decimals)
    uint256 public immutable programCap;

    // ================================================================
    //                          STRUCTS
    // ================================================================

    struct DisbursementRequest {
        bytes32 eventId;
        address recipient;
    }

    // ================================================================
    //                           STATE
    // ================================================================

    /// @notice Per-event records: status, caps, disbursement totals
    mapping(bytes32 => EventRecord) private _events;

    /// @notice eventId => tier => USDC amount (locked at event registration, immutable thereafter)
    mapping(bytes32 => mapping(uint8 => uint256)) private _eventTierAmounts;

    /// @notice eventId => wallet => claimed (double-payment guard)
    mapping(bytes32 => mapping(address => bool)) private _claimed;

    /// @notice eventId => wallet => delivery confirmed
    mapping(bytes32 => mapping(address => bool)) private _delivered;

    /// @notice requestId => request type string (for dispatch in _fulfillRequest)
    mapping(bytes32 => string) private _requestTypes;

    /// @notice requestId => eventId (for event verification requests)
    mapping(bytes32 => bytes32) private _verificationRequestToEvent;

    /// @notice requestId => DisbursementRequest metadata
    mapping(bytes32 => DisbursementRequest) private _disbursementRequests;

    /// @notice eventId => wallet => a CRE disbursement request is currently in-flight.
    /// @dev Prevents spamming claimDisbursement before the first callback lands,
    ///      which would force the CRE relayer to pay gas for thousands of onReport calls.
    mapping(bytes32 => mapping(address => bool)) private _hasPendingRequest;

    /// @notice Cumulative USDC deposited (informational)
    uint256 public totalDeposited;

    /// @notice Cumulative USDC disbursed (enforced against programCap)
    uint256 public totalDisbursed;

    // ================================================================
    //                        CONSTRUCTOR
    // ================================================================

    /**
     * @param _usdc           USDC token address
     * @param _perRecipientCap Hard ceiling per disbursement (6 decimals, e.g. 100e6 = $100).
     *                         No event tier amount may exceed this value.
     * @param _programCap     Max total USDC for the entire program
     * @param admin           Address granted DEFAULT_ADMIN_ROLE, DEPOSITOR_ROLE, PAUSER_ROLE.
     *                        In production this should be the funding organization's wallet,
     *                        not the platform operator.
     */
    constructor(
        address _usdc,
        uint256 _perRecipientCap,
        uint256 _programCap,
        address admin
    ) {
        require(_usdc != address(0), "ReliefTreasury: zero USDC address");
        require(admin != address(0), "ReliefTreasury: zero admin address");
        require(_perRecipientCap > 0, "ReliefTreasury: zero perRecipientCap");
        require(_programCap > 0, "ReliefTreasury: zero programCap");
        require(_perRecipientCap <= _programCap, "ReliefTreasury: cap inconsistency");

        usdc = IERC20(_usdc);
        perRecipientCap = _perRecipientCap;
        programCap = _programCap;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DEPOSITOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        __ChainlinkCREClient_init();
    }

    // ================================================================
    //                          FUNDING
    // ================================================================

    /**
     * @notice Deposit USDC into the treasury.
     * @dev Caller must hold DEPOSITOR_ROLE and have approved this contract.
     * @param amount Amount of USDC to deposit (6 decimals)
     */
    function deposit(uint256 amount) external onlyRole(DEPOSITOR_ROLE) whenNotPaused {
        require(amount > 0, "ReliefTreasury: zero amount");
        totalDeposited += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // ================================================================
    //                      EVENT MANAGEMENT
    // ================================================================

    /**
     * @notice Register a disaster event and commit to per-tier payout amounts atomically.
     * @dev Tier amounts are locked at registration and cannot be modified after the fact.
     *      This is the funding organization's onchain commitment: anyone can verify
     *      what was promised by reading the EventRegistered event.
     * @param eventId    Unique identifier (e.g. keccak256 of program+region+date)
     * @param perEventCap Total USDC budget for this event
     * @param tiers      Tier numbers (e.g. [1, 2])
     * @param amounts    USDC amounts per tier in 6-decimal units (e.g. [50000000, 100000000])
     */
    function registerEvent(
        bytes32 eventId,
        uint256 perEventCap,
        uint8[] calldata tiers,
        uint256[] calldata amounts
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_events[eventId].status != EventStatus.Unregistered) revert EventAlreadyRegistered(eventId);
        require(perEventCap > 0, "ReliefTreasury: zero perEventCap");
        require(tiers.length > 0 && tiers.length == amounts.length, "ReliefTreasury: tiers required");

        _events[eventId] = EventRecord({
            status: EventStatus.Pending,
            perEventCap: perEventCap,
            totalDisbursed: 0
        });

        for (uint256 i = 0; i < tiers.length; ) {
            require(amounts[i] > 0, "ReliefTreasury: zero tier amount");
            require(amounts[i] <= perRecipientCap, "ReliefTreasury: tier amount exceeds perRecipientCap");
            _eventTierAmounts[eventId][tiers[i]] = amounts[i];
            unchecked { ++i; }
        }

        emit EventRegistered(eventId, perEventCap, tiers, amounts);
    }

    /**
     * @notice Emit a RequestSent event for CRE to verify the disaster via external APIs.
     * @param eventId     The registered event to verify
     * @param externalRef JSON-encoded external references for CRE API queries
     *                    e.g. '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'
     * @return requestId  CRE request identifier
     */
    function requestEventVerification(
        bytes32 eventId,
        string calldata externalRef
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused returns (bytes32 requestId) {
        EventRecord storage ev = _events[eventId];
        if (ev.status == EventStatus.Unregistered) revert EventNotFound(eventId);
        if (ev.status != EventStatus.Pending) revert InvalidEventTransition(ev.status, EventStatus.Pending);

        bytes memory requestData = abi.encode(eventId, externalRef);
        requestId = _sendRequest(REQUEST_TYPE_EVENT_VERIFICATION, requestData);

        _requestTypes[requestId] = REQUEST_TYPE_EVENT_VERIFICATION;
        _verificationRequestToEvent[requestId] = eventId;

        emit EventVerificationRequested(requestId, eventId);
    }

    /**
     * @notice Admin activates a CRE-verified event to open disbursements.
     */
    function activateEvent(bytes32 eventId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EventRecord storage ev = _events[eventId];
        if (ev.status != EventStatus.Verified) revert InvalidEventTransition(ev.status, EventStatus.Verified);
        ev.status = EventStatus.Active;
        emit EventActivated(eventId);
    }

    /**
     * @notice Admin closes an event — no further disbursements allowed.
     */
    function closeEvent(bytes32 eventId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EventRecord storage ev = _events[eventId];
        if (ev.status == EventStatus.Unregistered) revert EventNotFound(eventId);
        ev.status = EventStatus.Closed;
        emit EventClosed(eventId);
    }

    // ================================================================
    //                    ROSTER TRANSPARENCY
    // ================================================================

    /**
     * @notice Anchor a processed roster's SHA-256 hash onchain for public auditability.
     * @dev The RosterAnchored event is the transparency hook for offchain tier assignments.
     *      Partners assign tiers via CSV — this event lets anyone verify which CSV was
     *      processed by hashing it and comparing to rosterHash.
     * @param rosterHash  SHA-256 of the raw CSV bytes (as bytes32)
     * @param eventId     The event this roster was processed against
     * @param program     Program name (e.g. "US-FLOOD-2026")
     * @param region      Region code (e.g. "US-CA")
     */
    function anchorRoster(
        bytes32 rosterHash,
        bytes32 eventId,
        string calldata program,
        string calldata region
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_events[eventId].status == EventStatus.Unregistered) revert EventNotFound(eventId);
        emit RosterAnchored(rosterHash, eventId, program, region);
    }

    // ================================================================
    //                      CLAIM (PULL MODEL)
    // ================================================================

    /**
     * @notice Recipient submits a disbursement claim.
     * @dev Emits RequestSent; CRE validates via OPA policy + Instruxi Enforcer group
     *      membership, extracts tier from group name suffix, then calls back via
     *      onReport() with (allowed, tier) to execute the transfer.
     * @param eventId  The active disaster event to claim against
     * @return requestId CRE request identifier
     */
    function claimDisbursement(bytes32 eventId)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 requestId)
    {
        EventRecord storage ev = _events[eventId];
        if (ev.status != EventStatus.Active)                    revert EventNotActive(eventId);
        if (_claimed[eventId][msg.sender])                      revert AlreadyClaimed(eventId, msg.sender);
        if (_hasPendingRequest[eventId][msg.sender])            revert PendingRequestExists(eventId, msg.sender);

        bytes memory requestData = abi.encode(eventId, msg.sender);
        requestId = _sendRequest(REQUEST_TYPE_DISBURSEMENT, requestData);

        _requestTypes[requestId] = REQUEST_TYPE_DISBURSEMENT;
        _disbursementRequests[requestId] = DisbursementRequest({
            eventId: eventId,
            recipient: msg.sender
        });
        _hasPendingRequest[eventId][msg.sender] = true;

        emit DisbursementRequested(requestId, eventId, msg.sender);
    }

    // ================================================================
    //                    CRE CALLBACKS
    // ================================================================

    /**
     * @notice CRE Forwarder calls this after DON consensus on the workflow result.
     * @dev The Chainlink Forwarder address must be in authorizedFulfillers.
     *      Report encoding:
     *        report[0]  = prefix byte (0x01 = event_verification, 0x02 = disbursement)
     *        report[1:] = abi.encode(bytes32 requestId, bool result)              [0x01]
     *                   = abi.encode(bytes32 requestId, bool allowed, uint8 tier) [0x02]
     * @param metadata  CRE workflow metadata (workflowId, workflowName, workflowOwner)
     * @param report    Encoded report payload
     */
    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (!authorizedFulfillers[msg.sender]) revert UnauthorizedFulfiller();
        (metadata); // silence unused warning
        _processReport(report);
    }

    /**
     * @notice Direct fulfillment entry point — used for testing and non-Forwarder fulfillers.
     * @dev For disbursements: responseData = abi.encode(bool allowed, uint8 tier).
     *      For event verification: responseData = abi.encode(bool verified).
     */
    function fulfillRequest(bytes32 requestId, bytes calldata responseData) external nonReentrant {
        if (!authorizedFulfillers[msg.sender]) revert UnauthorizedFulfiller();
        _validateAndFulfillRequest(requestId, msg.sender, bytes(responseData));
    }

    /**
     * @notice Cancel a timed-out request. Only the original requester can cancel after timeout.
     */
    function cancelRequest(bytes32 requestId) external nonReentrant {
        _validateAndCancelRequest(requestId, msg.sender);
    }

    // ================================================================
    //                    PROOF OF DELIVERY
    // ================================================================

    /**
     * @notice CRE fulfiller confirms a recipient received their funds.
     */
    function markDelivered(bytes32 eventId, address recipient) external {
        if (!authorizedFulfillers[msg.sender]) revert UnauthorizedFulfiller();
        _delivered[eventId][recipient] = true;
        emit DeliveryConfirmed(eventId, recipient);
    }

    // ================================================================
    //                          ADMIN
    // ================================================================

    function setFulfillerAuthorization(address fulfiller, bool authorized)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setFulfillerAuthorization(fulfiller, authorized);
    }

    /// @notice Update the CRE request timeout. Base contract enforces [1 day, 30 days].
    function setRequestTimeout(uint256 timeout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRequestTimeout(timeout); // reverts InvalidTimeout if outside [1 day, 30 days]
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    /**
     * @notice Emergency withdrawal of USDC — only callable when paused.
     */
    function emergencyWithdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert NotPaused();
        require(to != address(0), "ReliefTreasury: zero address");
        // Keep totalDeposited accurate — clamp to zero if more is withdrawn than deposited
        // (can happen if USDC was sent directly to the contract outside of deposit())
        totalDeposited = amount <= totalDeposited ? totalDeposited - amount : 0;
        usdc.safeTransfer(to, amount);
        emit EmergencyWithdraw(to, amount);
    }

    // ================================================================
    //                    INTERNAL: CRE REPORT PROCESSING
    // ================================================================

    function _processReport(bytes calldata report) internal {
        require(report.length > 1, "ReliefTreasury: empty report");
        uint8 prefix = uint8(report[0]);
        bytes calldata payload = report[1:];

        if (prefix == _REPORT_EVENT_VERIFICATION) {
            (bytes32 requestId, bool verified) = abi.decode(payload, (bytes32, bool));
            bytes memory responseData = abi.encode(verified);
            _validateAndFulfillRequest(requestId, msg.sender, responseData);
        } else if (prefix == _REPORT_DISBURSEMENT) {
            (bytes32 requestId, bool allowed, uint8 tier) = abi.decode(payload, (bytes32, bool, uint8));
            bytes memory responseData = abi.encode(allowed, tier);
            _validateAndFulfillRequest(requestId, msg.sender, responseData);
        }
        // Unknown prefix: no-op (forward-compatible)
    }

    // ================================================================
    //                    INTERNAL: ChainlinkCREClient HOOKS
    // ================================================================

    function _fulfillRequest(
        bytes32 requestId,
        address,
        bytes memory responseData
    ) internal override {
        bytes32 typeHash = keccak256(bytes(_requestTypes[requestId]));

        if (typeHash == _HASH_EVENT_VERIFICATION) {
            _handleEventVerification(requestId, responseData);
        } else if (typeHash == _HASH_DISBURSEMENT) {
            _handleDisbursement(requestId, responseData);
        }
    }

    function _cancelRequest(bytes32 requestId, address /*requester*/) internal override {
        DisbursementRequest storage req = _disbursementRequests[requestId];
        if (req.recipient != address(0)) {
            _hasPendingRequest[req.eventId][req.recipient] = false;
            emit PendingRequestCleared(req.eventId, req.recipient);
        }
    }

    // ================================================================
    //                    INTERNAL: DOMAIN LOGIC
    // ================================================================

    function _handleEventVerification(bytes32 requestId, bytes memory responseData) private {
        (bool verified) = abi.decode(responseData, (bool));
        bytes32 eventId = _verificationRequestToEvent[requestId];
        EventRecord storage ev = _events[eventId];

        if (verified && ev.status == EventStatus.Pending) {
            ev.status = EventStatus.Verified;
            emit EventVerified(eventId);
        }
    }

    function _handleDisbursement(bytes32 requestId, bytes memory responseData) private {
        (bool allowed, uint8 tier) = abi.decode(responseData, (bool, uint8));

        DisbursementRequest storage req = _disbursementRequests[requestId];
        bytes32 eventId   = req.eventId;
        address recipient = req.recipient;

        // Always clear pending — even on denial — so recipient can retry
        _hasPendingRequest[eventId][recipient] = false;
        emit PendingRequestCleared(eventId, recipient);

        if (!allowed) return;

        EventRecord storage ev = _events[eventId];

        // Graceful returns instead of reverts — CRE callback must not revert
        if (ev.status != EventStatus.Active) return;
        if (_claimed[eventId][recipient])    return;

        uint256 amount = _eventTierAmounts[eventId][tier];
        if (amount == 0) return;   // TierNotConfigured — graceful

        uint256 evAvail   = ev.perEventCap - ev.totalDisbursed;
        uint256 progAvail = programCap - totalDisbursed;
        uint256 balance   = usdc.balanceOf(address(this));

        // Cap checks — graceful returns instead of reverts
        if (amount > evAvail || amount > progAvail || amount > balance) return;

        _claimed[eventId][recipient] = true;
        ev.totalDisbursed           += amount;
        totalDisbursed              += amount;

        usdc.safeTransfer(recipient, amount);
        emit Disbursed(eventId, recipient, amount);
    }

    // ================================================================
    //                          VIEW
    // ================================================================

    function getEventRecord(bytes32 eventId) external view returns (EventRecord memory) {
        return _events[eventId];
    }

    function getEventTierAmount(bytes32 eventId, uint8 tier) external view returns (uint256) {
        return _eventTierAmounts[eventId][tier];
    }

    function hasClaimed(bytes32 eventId, address recipient) external view returns (bool) {
        return _claimed[eventId][recipient];
    }

    function hasDelivered(bytes32 eventId, address recipient) external view returns (bool) {
        return _delivered[eventId][recipient];
    }

    function availableFunds() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function remainingProgramCap() external view returns (uint256) {
        return programCap - totalDisbursed;
    }
}
