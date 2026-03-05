// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReliefTreasury} from "./interfaces/IReliefTreasury.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";

/**
 * @title ReliefTreasury
 * @notice CRE-Orchestrated Disaster Relief Distribution Treasury
 *
 * @dev Architecture:
 *   - Holds USDC and is the final enforcement point for all monetary safety guarantees.
 *   - Implements IReceiver (standard Chainlink CRE interface) to receive workflow results.
 *   - Emits RequestSent events to trigger CRE workflows (EVM Log Trigger).
 *   - No offchain component — including Chainlink CRE — can over-transfer funds or
 *     bypass onchain invariants.
 *
 * Two CRE request types:
 *   1. "event_verification" — CRE queries USGS/GDACS/ReliefWeb (2-of-3 rule) and
 *      calls back with verified=true/false.
 *   2. "eligibility_registration" — Admin submits candidate wallets + tiers; CRE
 *      validates each via OPA policy and calls back with only the approved recipients.
 *      Approved recipients are written to _eligible[eventId][addr] = tier.
 *
 * Disbursement (pull model):
 *   - Recipients call claimDisbursement(eventId) once eligibility is set onchain.
 *   - The contract checks _eligible[eventId][msg.sender] directly — no CRE round-trip.
 *   - This makes CRE the trusted writer of eligibility state; the contract enforces it.
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
 *   - No payout without CRE-set eligibility (_eligible[eventId][recipient] > 0)
 *   - No payout for an unconfigured tier (TierNotConfigured)
 *   - No payout above per-event cap
 *   - No payout above program cap
 *   - No double payment per event per recipient
 *   - Only authorized fulfillers can set eligibility (via CRE Forwarder)
 *
 * CRE Report Encoding (prefix byte routes the report):
 *   0x01 = event_verification result:       abi.encode(bytes32 requestId, bool verified)
 *   0x02 = eligibility_registration result: abi.encode(bytes32 requestId, address[] recipients, uint8[] tiers)
 */
contract ReliefTreasury is IReliefTreasury, IReceiver, AccessControl, Pausable, ReentrancyGuard {
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
    string public constant REQUEST_TYPE_ELIGIBILITY        = "eligibility_registration";

    /// @dev Report prefix bytes (first byte of onReport payload)
    uint8 private constant _REPORT_EVENT_VERIFICATION = 0x01;
    uint8 private constant _REPORT_ELIGIBILITY        = 0x02;

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
    //                           STATE
    // ================================================================

    /// @notice Authorized CRE workflow fulfiller addresses (e.g. Chainlink Forwarder)
    mapping(address => bool) public authorizedFulfillers;

    /// @notice Counter for generating unique request IDs (starts at 1)
    uint256 private _requestIdCounter;

    /// @notice Replay protection: requestId => fulfilled
    mapping(bytes32 => bool) private _requestFulfilled;

    /// @notice Optional workflowId pinning for production hardening (0 = disabled)
    bytes32 private _expectedWorkflowId;

    /// @notice Per-event records: status, caps, disbursement totals
    mapping(bytes32 => EventRecord) private _events;

    /// @notice eventId => tier => USDC amount (locked at event registration, immutable thereafter)
    mapping(bytes32 => mapping(uint8 => uint256)) private _eventTierAmounts;

    /// @notice eventId => wallet => claimed (double-payment guard)
    mapping(bytes32 => mapping(address => bool)) private _claimed;

    /// @notice eventId => wallet => delivery confirmed
    mapping(bytes32 => mapping(address => bool)) private _delivered;

    /// @notice requestId => eventId (for both event_verification and eligibility_registration)
    mapping(bytes32 => bytes32) private _requestToEvent;

    /// @notice eventId => wallet => CRE-assigned payout tier (0 = not eligible, 1-255 = tier N)
    /// @dev Written exclusively by CRE fulfiller via requestEligibilityRegistration → onReport.
    ///      This is the onchain eligibility gate: claimDisbursement checks this before paying.
    mapping(bytes32 => mapping(address => uint8)) private _eligible;

    /// @notice Cumulative USDC deposited (informational)
    uint256 public totalDeposited;

    /// @notice Cumulative USDC disbursed (enforced against programCap)
    uint256 public totalDisbursed;

    // ================================================================
    //                           EVENTS
    // ================================================================

    /// @notice Emitted when a fulfiller is authorized or deauthorized
    event FulfillerAuthorizationUpdated(address indexed fulfiller, bool authorized);

    // ================================================================
    //                           ERRORS
    // ================================================================

    error UnauthorizedFulfiller();

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

        _requestIdCounter = 1;
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

        _requestToEvent[requestId] = eventId;

        emit EventVerificationRequested(requestId, eventId);
    }

    /**
     * @notice Admin closes an event — no further disbursements allowed.
     * @dev Cannot close an Active event. Once Active, eligible recipients retain the right
     *      to claim until the contract is paused via an emergency. This prevents an admin
     *      from silently locking out recipients who have not yet claimed.
     */
    function closeEvent(bytes32 eventId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EventRecord storage ev = _events[eventId];
        if (ev.status == EventStatus.Unregistered) revert EventNotFound(eventId);
        if (ev.status == EventStatus.Active) revert InvalidEventTransition(ev.status, EventStatus.Closed);
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
    //                 ELIGIBILITY REGISTRATION (CRE)
    // ================================================================

    /**
     * @notice Admin submits a candidate eligibility batch to CRE for OPA validation.
     * @dev Emits RequestSent to trigger the CRE eligibility_registration workflow.
     *      CRE validates each recipient via OPA policy and calls back via onReport()
     *      with only the approved recipients — writing _eligible[eventId][addr] = tier.
     *
     *      Trust model: the admin provides the candidate list (from processRoster),
     *      but CRE independently validates each wallet via OPA before writing onchain.
     *      The onchain contract only accepts eligibility written by an authorized
     *      CRE fulfiller — not directly from the admin.
     *
     * @param eventId    The event to register eligibility for
     * @param recipients Candidate wallet addresses (from processRoster output)
     * @param tiers      Claimed payout tier per recipient (1-255; 0 is invalid)
     * @return requestId CRE request identifier
     */
    function requestEligibilityRegistration(
        bytes32 eventId,
        address[] calldata recipients,
        uint8[] calldata tiers
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused returns (bytes32 requestId) {
        if (_events[eventId].status == EventStatus.Unregistered) revert EventNotFound(eventId);
        if (_events[eventId].status == EventStatus.Closed) revert EventNotActive(eventId);
        require(recipients.length > 0, "ReliefTreasury: empty recipients");
        require(recipients.length == tiers.length, "ReliefTreasury: length mismatch");

        bytes memory requestData = abi.encode(eventId, recipients, tiers);
        requestId = _sendRequest(REQUEST_TYPE_ELIGIBILITY, requestData);

        _requestToEvent[requestId] = eventId;

        emit EligibilityRegistrationRequested(requestId, eventId);
    }

    // ================================================================
    //                      CLAIM (PULL MODEL)
    // ================================================================

    /**
     * @notice Recipient claims their disaster relief disbursement.
     * @dev Synchronous — no CRE round-trip. Requires CRE to have written eligibility
     *      onchain via requestEligibilityRegistration → onReport.
     *
     *      Reverts if:
     *        - Event is not Active
     *        - Recipient has already claimed
     *        - CRE has not set eligibility for this recipient (_eligible = 0)
     *        - Tier has no configured amount
     *        - Any cap would be exceeded
     *
     * @param eventId The active disaster event to claim against
     */
    function claimDisbursement(bytes32 eventId)
        external
        nonReentrant
        whenNotPaused
    {
        EventRecord storage ev = _events[eventId];
        if (ev.status != EventStatus.Active)  revert EventNotActive(eventId);
        if (_claimed[eventId][msg.sender])     revert AlreadyClaimed(eventId, msg.sender);

        uint8 tier = _eligible[eventId][msg.sender];
        if (tier == 0)                         revert NotEligible(eventId, msg.sender);

        uint256 amount = _eventTierAmounts[eventId][tier];
        if (amount == 0)                       revert TierNotConfigured(tier);

        uint256 evAvail   = ev.perEventCap - ev.totalDisbursed;
        uint256 progAvail = programCap - totalDisbursed;
        uint256 balance   = usdc.balanceOf(address(this));

        if (amount > evAvail)   revert PerEventCapExceeded(evAvail, amount);
        if (amount > progAvail) revert ProgramCapExceeded(progAvail, amount);
        if (amount > balance)   revert InsufficientTreasuryFunds(balance, amount);

        _claimed[eventId][msg.sender] = true;
        ev.totalDisbursed            += amount;
        totalDisbursed               += amount;

        usdc.safeTransfer(msg.sender, amount);
        emit Disbursed(eventId, msg.sender, amount);
    }

    // ================================================================
    //                    CRE CALLBACKS
    // ================================================================

    /**
     * @notice CRE Forwarder calls this after DON consensus on the workflow result.
     * @dev The Chainlink Forwarder address must be in authorizedFulfillers.
     *      Report encoding:
     *        report[0]  = prefix byte (0x01 = event_verification, 0x02 = eligibility_registration)
     *        report[1:] = abi.encode(bytes32 requestId, bool verified)                           [0x01]
     *                   = abi.encode(bytes32 requestId, address[] recipients, uint8[] tiers)     [0x02]
     * @param metadata  CRE workflow metadata (workflowId at offset 0 if workflowId pinning enabled)
     * @param report    Encoded report payload
     */
    function onReport(bytes calldata metadata, bytes calldata report) external override(IReceiver, IReliefTreasury) nonReentrant {
        if (!authorizedFulfillers[msg.sender]) revert UnauthorizedFulfiller();
        if (_expectedWorkflowId != bytes32(0)) {
            bytes32 workflowId;
            assembly { workflowId := calldataload(metadata.offset) }
            require(workflowId == _expectedWorkflowId, "ReliefTreasury: wrong workflow");
        }
        _processReport(report);
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
        require(fulfiller != address(0), "ReliefTreasury: invalid fulfiller");
        authorizedFulfillers[fulfiller] = authorized;
        emit FulfillerAuthorizationUpdated(fulfiller, authorized);
    }

    /**
     * @notice Pin a specific CRE workflowId. Set to bytes32(0) to disable pinning.
     * @dev When set, onReport will revert if the first 32 bytes of metadata do not match.
     */
    function setExpectedWorkflowId(bytes32 workflowId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _expectedWorkflowId = workflowId;
        emit ExpectedWorkflowIdUpdated(workflowId);
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
            require(!_requestFulfilled[requestId], "ReliefTreasury: already fulfilled");
            _requestFulfilled[requestId] = true;
            _handleEventVerification(requestId, verified);
        } else if (prefix == _REPORT_ELIGIBILITY) {
            (bytes32 requestId, address[] memory recipients, uint8[] memory tiers) =
                abi.decode(payload, (bytes32, address[], uint8[]));
            require(!_requestFulfilled[requestId], "ReliefTreasury: already fulfilled");
            _requestFulfilled[requestId] = true;
            _handleEligibilityRegistration(requestId, recipients, tiers);
        }
        // Unknown prefix: no-op (forward-compatible)
    }

    // ================================================================
    //                    INTERNAL: DOMAIN LOGIC
    // ================================================================

    function _handleEventVerification(bytes32 requestId, bool verified) private {
        bytes32 eventId = _requestToEvent[requestId];
        EventRecord storage ev = _events[eventId];

        if (verified && ev.status == EventStatus.Pending) {
            ev.status = EventStatus.Active;
            emit EventVerified(eventId);
            emit EventActivated(eventId);
        }
    }

    /**
     * @notice CRE-provided eligibility batch. Writes _eligible[eventId][addr] = tier
     *         for each OPA-approved recipient in the batch.
     * @dev Only approved recipients are included in the CRE response (CRE filtered via OPA).
     *      This function trusts the Chainlink Forwarder + DON consensus on the report.
     */
    function _handleEligibilityRegistration(
        bytes32 requestId,
        address[] memory recipients,
        uint8[] memory tiers
    ) private {
        bytes32 eventId = _requestToEvent[requestId];

        for (uint256 i = 0; i < recipients.length; ) {
            uint8 tier = tiers[i];
            // First write wins — prevents a second CRE batch from overwriting an existing grant.
            if (tier > 0 && _eligible[eventId][recipients[i]] == 0) {
                _eligible[eventId][recipients[i]] = tier;
                emit EligibilitySet(eventId, recipients[i], tier);
            }
            unchecked { ++i; }
        }
    }

    // ================================================================
    //                    INTERNAL: REQUEST HELPER
    // ================================================================

    function _sendRequest(string memory requestType, bytes memory requestData)
        private
        returns (bytes32 requestId)
    {
        requestId = keccak256(abi.encodePacked(
            block.chainid, address(this), _requestIdCounter++, block.timestamp, msg.sender
        ));
        emit RequestSent(requestId, msg.sender, requestType, requestData);
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

    function getEligibilityTier(bytes32 eventId, address recipient) external view returns (uint8) {
        return _eligible[eventId][recipient];
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

    /**
     * @notice ERC165 interface detection — advertises IReceiver support to CRE infrastructure.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
