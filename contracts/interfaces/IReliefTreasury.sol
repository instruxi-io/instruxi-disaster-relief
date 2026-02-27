// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReliefTreasury
/// @notice Interface for the CRE-orchestrated disaster relief treasury
interface IReliefTreasury {
    // ================================================================
    //                           ENUMS
    // ================================================================

    enum EventStatus { Unregistered, Pending, Verified, Active, Closed }

    // ================================================================
    //                           STRUCTS
    // ================================================================

    struct EventRecord {
        EventStatus status;
        uint256 perEventCap;
        uint256 totalDisbursed;
    }

    // ================================================================
    //                           EVENTS
    // ================================================================

    event Deposited(address indexed depositor, uint256 amount);

    /// @notice Emitted when a disaster event is registered.
    /// @dev tiers and amounts are locked at registration and cannot be changed —
    ///      this event is the onchain commitment the funding org makes upfront.
    event EventRegistered(bytes32 indexed eventId, uint256 perEventCap, uint8[] tiers, uint256[] amounts);

    event EventVerificationRequested(bytes32 indexed requestId, bytes32 indexed eventId);
    event EventVerified(bytes32 indexed eventId);
    event EventActivated(bytes32 indexed eventId);
    event EventClosed(bytes32 indexed eventId);

    /// @notice Emitted when an admin anchors a processed roster hash onchain.
    /// @dev Anyone can verify transparency: hash the original CSV and compare to this event.
    event RosterAnchored(bytes32 indexed rosterHash, bytes32 indexed eventId, string program, string region);

    event DisbursementRequested(bytes32 indexed requestId, bytes32 indexed eventId, address indexed recipient);
    event Disbursed(bytes32 indexed eventId, address indexed recipient, uint256 amount);
    event DeliveryConfirmed(bytes32 indexed eventId, address indexed recipient);
    event EmergencyWithdraw(address indexed to, uint256 amount);

    // ================================================================
    //                           ERRORS
    // ================================================================

    error EventAlreadyRegistered(bytes32 eventId);
    error EventNotFound(bytes32 eventId);
    error EventNotActive(bytes32 eventId);
    error AlreadyClaimed(bytes32 eventId, address recipient);
    error TierNotConfigured(uint8 tier);
    error PerEventCapExceeded(uint256 available, uint256 requested);
    error ProgramCapExceeded(uint256 available, uint256 requested);
    error InsufficientTreasuryFunds(uint256 available, uint256 requested);
    error InvalidEventTransition(EventStatus current, EventStatus required);
    error NotPaused();

    // ================================================================
    //                      FUNDING
    // ================================================================

    function deposit(uint256 amount) external;

    // ================================================================
    //                    EVENT MANAGEMENT
    // ================================================================

    /// @notice Register a disaster event and commit to per-tier payout amounts atomically.
    /// @param eventId    Unique event identifier
    /// @param perEventCap Total USDC budget for this event
    /// @param tiers      Tier numbers (e.g. [1, 2])
    /// @param amounts    USDC amounts per tier in 6-decimal units (e.g. [50000000, 100000000])
    function registerEvent(
        bytes32 eventId,
        uint256 perEventCap,
        uint8[] calldata tiers,
        uint256[] calldata amounts
    ) external;

    function requestEventVerification(bytes32 eventId, string calldata externalRef) external returns (bytes32 requestId);

    function activateEvent(bytes32 eventId) external;

    function closeEvent(bytes32 eventId) external;

    // ================================================================
    //                    ROSTER TRANSPARENCY
    // ================================================================

    /// @notice Anchor a processed roster's SHA-256 hash onchain for public auditability.
    /// @dev Anyone can hash the original CSV and compare to the RosterAnchored event.
    ///      This is the transparency mechanism for offchain tier assignments.
    function anchorRoster(
        bytes32 rosterHash,
        bytes32 eventId,
        string calldata program,
        string calldata region
    ) external;

    // ================================================================
    //                    CLAIM (PULL MODEL)
    // ================================================================

    function claimDisbursement(bytes32 eventId) external returns (bytes32 requestId);

    // ================================================================
    //                    CRE CALLBACKS
    // ================================================================

    function onReport(bytes calldata metadata, bytes calldata report) external;

    function fulfillRequest(bytes32 requestId, bytes calldata responseData) external;

    function cancelRequest(bytes32 requestId) external;

    // ================================================================
    //                    PROOF OF DELIVERY
    // ================================================================

    function markDelivered(bytes32 eventId, address recipient) external;

    // ================================================================
    //                    ADMIN
    // ================================================================

    function setFulfillerAuthorization(address fulfiller, bool authorized) external;

    function emergencyWithdraw(address to, uint256 amount) external;

    function pause() external;

    function unpause() external;

    // ================================================================
    //                    VIEW
    // ================================================================

    function getEventRecord(bytes32 eventId) external view returns (EventRecord memory);

    /// @notice Returns the USDC payout amount for a given tier within a specific event.
    function getEventTierAmount(bytes32 eventId, uint8 tier) external view returns (uint256);

    function hasClaimed(bytes32 eventId, address recipient) external view returns (bool);

    function hasDelivered(bytes32 eventId, address recipient) external view returns (bool);

    function availableFunds() external view returns (uint256);

    function remainingProgramCap() external view returns (uint256);
}
