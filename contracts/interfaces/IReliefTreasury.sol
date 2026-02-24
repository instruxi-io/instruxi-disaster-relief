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
    event EventRegistered(bytes32 indexed eventId, uint256 perEventCap);
    event EventVerificationRequested(bytes32 indexed requestId, bytes32 indexed eventId);
    event EventVerified(bytes32 indexed eventId);
    event EventActivated(bytes32 indexed eventId);
    event EventClosed(bytes32 indexed eventId);
    event TierAmountsUpdated(uint8[] tiers, uint256[] amounts);
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

    function registerEvent(bytes32 eventId, uint256 perEventCap) external;

    function requestEventVerification(bytes32 eventId, string calldata externalRef) external returns (bytes32 requestId);

    function activateEvent(bytes32 eventId) external;

    function closeEvent(bytes32 eventId) external;

    // ================================================================
    //                      TIER AMOUNTS
    // ================================================================

    function setTierAmounts(uint8[] calldata tiers, uint256[] calldata amounts) external;

    function getTierAmount(uint8 tier) external view returns (uint256);

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

    function hasClaimed(bytes32 eventId, address recipient) external view returns (bool);

    function hasDelivered(bytes32 eventId, address recipient) external view returns (bool);

    function availableFunds() external view returns (uint256);

    function remainingProgramCap() external view returns (uint256);
}
