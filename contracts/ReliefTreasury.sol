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
 * Enforced invariants (all onchain, cannot be bypassed):
 *   - No payout unless event is Active (verified by CRE fulfiller)
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

    /// @notice Maximum USDC disbursed per recipient per event (6 decimals, e.g. 100e6 = $100)
    /// @dev Serves as a ceiling for tier amounts set via setTierAmounts
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

    /// @notice tier number => USDC amount (6 decimals); set by admin via setTierAmounts
    mapping(uint8 => uint256) private _tierAmounts;

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

    /// @notice Cumulative USDC deposited (informational)
    uint256 public totalDeposited;

    /// @notice Cumulative USDC disbursed (enforced against programCap)
    uint256 public totalDisbursed;

    // ================================================================
    //                        CONSTRUCTOR
    // ================================================================

    /**
     * @param _usdc           USDC token address
     * @param _perRecipientCap Max USDC per recipient per event (6 decimals, e.g. 100e6 = $100)
     *                         Acts as ceiling for tier amounts; actual payout = _tierAmounts[tier]
     * @param _programCap     Max total USDC for the entire program
     * @param admin           Address granted DEFAULT_ADMIN_ROLE, DEPOSITOR_ROLE, PAUSER_ROLE
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
     * @notice Register a new disaster event.
     * @param eventId     Unique identifier (e.g. keccak256 of program+region+date)
     * @param perEventCap Maximum USDC disbursable for this event
     */
    function registerEvent(bytes32 eventId, uint256 perEventCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_events[eventId].status != EventStatus.Unregistered) revert EventAlreadyRegistered(eventId);
        require(perEventCap > 0, "ReliefTreasury: zero perEventCap");
        _events[eventId] = EventRecord({
            status: EventStatus.Pending,
            perEventCap: perEventCap,
            totalDisbursed: 0
        });
        emit EventRegistered(eventId, perEventCap);
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
    //                        TIER AMOUNTS
    // ================================================================

    /**
     * @notice Set USDC payout amounts for each disbursement tier.
     * @dev Each amount must not exceed perRecipientCap. CRE extracts the tier
     *      from the recipient's Instruxi Enforcer group name suffix and passes
     *      it back via onReport(). The contract resolves amount = _tierAmounts[tier].
     * @param tiers   Array of tier numbers (e.g. [1, 2])
     * @param amounts Array of USDC amounts in 6-decimal units (e.g. [50000000, 100000000])
     */
    function setTierAmounts(
        uint8[] calldata tiers,
        uint256[] calldata amounts
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(tiers.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < tiers.length; ) {
            require(amounts[i] <= perRecipientCap, "exceeds perRecipientCap");
            _tierAmounts[tiers[i]] = amounts[i];
            unchecked { ++i; }
        }
        emit TierAmountsUpdated(tiers, amounts);
    }

    /**
     * @notice Returns the configured USDC payout amount for a given tier.
     * @param tier Tier number (1 = standard, 2 = priority, etc.)
     */
    function getTierAmount(uint8 tier) external view returns (uint256) {
        return _tierAmounts[tier];
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
        if (ev.status != EventStatus.Active) revert EventNotActive(eventId);
        if (_claimed[eventId][msg.sender]) revert AlreadyClaimed(eventId, msg.sender);

        bytes memory requestData = abi.encode(eventId, msg.sender);
        requestId = _sendRequest(REQUEST_TYPE_DISBURSEMENT, requestData);

        _requestTypes[requestId] = REQUEST_TYPE_DISBURSEMENT;
        _disbursementRequests[requestId] = DisbursementRequest({
            eventId: eventId,
            recipient: msg.sender
        });

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
     *        report[1:] = abi.encode(bytes32 requestId, bool result)          [0x01]
     *                   = abi.encode(bytes32 requestId, bool allowed, uint8 tier) [0x02]
     * @param metadata  CRE workflow metadata (workflowId, workflowName, workflowOwner)
     * @param report    Encoded report payload
     */
    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (!authorizedFulfillers[msg.sender]) revert UnauthorizedFulfiller();
        // metadata available for optional workflow identity checks (not enforced for MVP)
        (metadata); // silence unused warning
        _processReport(report);
    }

    /**
     * @notice Direct fulfillment entry point — used for testing and non-Forwarder fulfillers.
     * @dev Fulfiller must be in authorizedFulfillers.
     *      For disbursements: responseData = abi.encode(bool allowed, uint8 tier).
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

    function setRequestTimeout(uint256 timeout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRequestTimeout(timeout);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    /**
     * @notice Emergency withdrawal of USDC — only callable when paused.
     */
    function emergencyWithdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert NotPaused();
        require(to != address(0), "ReliefTreasury: zero address");
        usdc.safeTransfer(to, amount);
        emit EmergencyWithdraw(to, amount);
    }

    // ================================================================
    //                    INTERNAL: CRE REPORT PROCESSING
    // ================================================================

    /**
     * @notice Decode and route an incoming CRE report.
     * @dev report[0] is the prefix byte; report[1:] is the abi-encoded payload.
     */
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

    /**
     * @notice Dispatch fulfilled request to the correct handler based on stored type.
     */
    function _fulfillRequest(
        bytes32 requestId,
        address, /* requester — enforced by onchain state, not CRE response */
        bytes memory responseData
    ) internal override {
        bytes32 typeHash = keccak256(bytes(_requestTypes[requestId]));

        if (typeHash == _HASH_EVENT_VERIFICATION) {
            _handleEventVerification(requestId, responseData);
        } else if (typeHash == _HASH_DISBURSEMENT) {
            _handleDisbursement(requestId, responseData);
        }
    }

    function _cancelRequest(bytes32 /*requestId*/, address /*requester*/) internal override {
        // No additional state cleanup required for MVP
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
        // If not verified: event stays Pending; admin may retry with updated externalRef
    }

    function _handleDisbursement(bytes32 requestId, bytes memory responseData) private {
        (bool allowed, uint8 tier) = abi.decode(responseData, (bool, uint8));
        if (!allowed) return; // OPA denied — no transfer

        DisbursementRequest storage req = _disbursementRequests[requestId];
        bytes32 eventId = req.eventId;
        address recipient = req.recipient;

        EventRecord storage ev = _events[eventId];

        // ── Onchain invariants — enforced regardless of CRE response ──
        if (ev.status != EventStatus.Active) return;
        if (_claimed[eventId][recipient]) return;

        uint256 amount = _tierAmounts[tier];
        if (amount == 0) revert TierNotConfigured(tier);

        uint256 evAvail   = ev.perEventCap - ev.totalDisbursed;
        uint256 progAvail = programCap - totalDisbursed;
        uint256 balance   = usdc.balanceOf(address(this));

        if (amount > evAvail)   revert PerEventCapExceeded(evAvail, amount);
        if (amount > progAvail) revert ProgramCapExceeded(progAvail, amount);
        if (amount > balance)   revert InsufficientTreasuryFunds(balance, amount);

        // ── State before transfer (reentrancy — also guarded by nonReentrant on callers) ──
        _claimed[eventId][recipient]  = true;
        ev.totalDisbursed            += amount;
        totalDisbursed               += amount;

        usdc.safeTransfer(recipient, amount);

        emit Disbursed(eventId, recipient, amount);
    }

    // ================================================================
    //                          VIEW
    // ================================================================

    function getEventRecord(bytes32 eventId) external view returns (EventRecord memory) {
        return _events[eventId];
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
