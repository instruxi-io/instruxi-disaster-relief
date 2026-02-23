// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ChainlinkCREClient
 * @notice Abstract base contract for Chainlink CRE (Compute Runtime Environment) integration
 * @dev Provides internal helpers for CRE request/response pattern via EVM Log Triggers
 *
 * Architecture:
 * 1. Contract calls _sendRequest() which emits RequestSent event
 * 2. Off-chain CRE workflow (Go) listens for event via EVM Log Trigger
 * 3. CRE workflow processes request and calls implementing contract's fulfillRequest()
 * 4. Implementing contract validates fulfiller and calls _validateAndFulfillRequest()
 * 5. This base contract validates request state and calls _fulfillRequest() implementation
 *
 * Implementing contracts MUST:
 * - Define public fulfillRequest() with access control (nonReentrant + fulfiller check)
 * - Define public cancelRequest() with access control (nonReentrant + requester check)
 * - Define admin functions for managing authorizedFulfillers mapping
 * - Implement abstract _fulfillRequest() and _cancelRequest() functions
 */
abstract contract ChainlinkCREClient {
    // =============================================================
    //                           STORAGE
    // =============================================================

    /// @notice Mapping of authorized CRE workflow fulfiller addresses
    mapping(address => bool) public authorizedFulfillers;

    /// @notice Counter for generating unique request IDs
    uint256 private requestIdCounter;

    /// @notice Mapping to track pending requests
    mapping(bytes32 => RequestStatus) public requests;

    /// @notice Timeout period for requests (default 7 days)
    uint256 public requestTimeout = 7 days;

    // =============================================================
    //                           STRUCTS
    // =============================================================

    struct RequestStatus {
        address requester;      // Address that initiated the request
        uint256 timestamp;      // When the request was made
        bool fulfilled;         // Whether request has been fulfilled
        bool exists;            // Whether request exists (to differentiate from default values)
    }

    // =============================================================
    //                           EVENTS
    // =============================================================

    /**
     * @notice Emitted when a new request is sent (CRE EVM Log Trigger listens for this)
     * @dev CRE workflows filter on this event signature and decode parameters
     * @param requestId Unique identifier for this request
     * @param requester Address that initiated the request
     * @param requestType Type of request (e.g., "valuation", "oracle_data")
     * @param requestData ABI-encoded request parameters
     */
    event RequestSent(
        bytes32 indexed requestId,
        address indexed requester,
        string requestType,
        bytes requestData
    );

    /**
     * @notice Emitted when a request is fulfilled by CRE workflow
     * @param requestId The request that was fulfilled
     * @param fulfiller Address of the CRE workflow that fulfilled the request
     */
    event RequestFulfilled(
        bytes32 indexed requestId,
        address indexed fulfiller
    );

    /**
     * @notice Emitted when a request is cancelled due to timeout
     * @param requestId The request that was cancelled
     * @param requester Address that cancelled the request
     */
    event RequestCancelled(
        bytes32 indexed requestId,
        address indexed requester
    );

    /**
     * @notice Emitted when a fulfiller is authorized or deauthorized
     * @param fulfiller Address of the fulfiller
     * @param authorized Whether the fulfiller is now authorized
     */
    event FulfillerAuthorizationUpdated(
        address indexed fulfiller,
        bool authorized
    );

    /**
     * @notice Emitted when request timeout is updated
     * @param oldTimeout Previous timeout value
     * @param newTimeout New timeout value
     */
    event RequestTimeoutUpdated(
        uint256 oldTimeout,
        uint256 newTimeout
    );

    // =============================================================
    //                           ERRORS
    // =============================================================

    error UnauthorizedFulfiller();
    error RequestNotPending();
    error RequestAlreadyFulfilled();
    error RequestDoesNotExist();
    error RequestTimeoutNotReached();
    error InvalidTimeout();

    // =============================================================
    //                         INITIALIZATION
    // =============================================================

    /**
     * @notice Initialize the CRE client state
     * @dev Must be called by implementing contract's constructor or initializer
     */
    function __ChainlinkCREClient_init() internal {
        requestIdCounter = 1; // Start at 1 to avoid confusion with default values
    }

    // =============================================================
    //                    REQUEST MANAGEMENT
    // =============================================================

    /**
     * @notice Internal function to send a request to CRE workflow
     * @dev Emits RequestSent event that CRE EVM Log Trigger listens for
     * @param requestType Type identifier for the request
     * @param requestData ABI-encoded request parameters
     * @return requestId Unique identifier for this request
     */
    function _sendRequest(
        string memory requestType,
        bytes memory requestData
    ) internal returns (bytes32 requestId) {
        // Generate unique request ID
        requestId = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                requestIdCounter++,
                block.timestamp,
                msg.sender
            )
        );

        // Store request status
        requests[requestId] = RequestStatus({
            requester: msg.sender,
            timestamp: block.timestamp,
            fulfilled: false,
            exists: true
        });

        // Emit event for CRE EVM Log Trigger to detect
        emit RequestSent(requestId, msg.sender, requestType, requestData);

        return requestId;
    }

    /**
     * @notice Internal helper to validate and fulfill a CRE request
     * @dev Implementing contract's public fulfillRequest() should call this after access control checks
     * @param requestId The ID of the request being fulfilled
     * @param fulfiller Address fulfilling the request (msg.sender from public function)
     * @param responseData ABI-encoded response data from CRE workflow
     */
    function _validateAndFulfillRequest(
        bytes32 requestId,
        address fulfiller,
        bytes memory responseData
    ) internal {
        // Validate fulfiller authorization
        if (!authorizedFulfillers[fulfiller]) {
            revert UnauthorizedFulfiller();
        }

        // Validate request exists
        RequestStatus storage request = requests[requestId];
        if (!request.exists) {
            revert RequestDoesNotExist();
        }

        // Validate request is not already fulfilled
        if (request.fulfilled) {
            revert RequestAlreadyFulfilled();
        }

        // Mark as fulfilled
        request.fulfilled = true;

        // Emit fulfillment event
        emit RequestFulfilled(requestId, fulfiller);

        // Call implementation-specific fulfillment logic
        _fulfillRequest(requestId, request.requester, responseData);
    }

    /**
     * @notice Internal helper to validate and cancel a CRE request
     * @dev Implementing contract's public cancelRequest() should call this after access control checks
     * @param requestId The ID of the request to cancel
     * @param canceller Address cancelling the request (msg.sender from public function)
     */
    function _validateAndCancelRequest(bytes32 requestId, address canceller) internal {
        RequestStatus storage request = requests[requestId];

        // Validate request exists
        if (!request.exists) {
            revert RequestDoesNotExist();
        }

        // Validate request is not already fulfilled
        if (request.fulfilled) {
            revert RequestAlreadyFulfilled();
        }

        // Validate caller is the requester
        require(request.requester == canceller, "Not requester");

        // Validate timeout has passed
        if (block.timestamp < request.timestamp + requestTimeout) {
            revert RequestTimeoutNotReached();
        }

        // Mark as fulfilled to prevent double cancellation
        request.fulfilled = true;

        // Emit cancellation event
        emit RequestCancelled(requestId, canceller);

        // Call implementation-specific cancellation logic
        _cancelRequest(requestId, canceller);
    }

    // =============================================================
    //                    ABSTRACT FUNCTIONS
    // =============================================================

    /**
     * @notice Implementation-specific fulfillment logic
     * @dev Must be implemented by inheriting contracts
     * @param requestId The request being fulfilled
     * @param requester Original requester address
     * @param responseData Response data from CRE workflow
     */
    function _fulfillRequest(
        bytes32 requestId,
        address requester,
        bytes memory responseData
    ) internal virtual;

    /**
     * @notice Implementation-specific cancellation logic
     * @dev Must be implemented by inheriting contracts
     * @param requestId The request being cancelled
     * @param requester Address that cancelled the request
     */
    function _cancelRequest(
        bytes32 requestId,
        address requester
    ) internal virtual;

    // =============================================================
    //                      ADMIN HELPERS
    // =============================================================

    /**
     * @notice Internal helper to update fulfiller authorization
     * @dev Implementing contract should expose public function with access control that calls this
     * @param fulfiller Address of the CRE workflow
     * @param authorized Whether to authorize or deauthorize
     */
    function _setFulfillerAuthorization(address fulfiller, bool authorized) internal {
        require(fulfiller != address(0), "Invalid fulfiller address");
        authorizedFulfillers[fulfiller] = authorized;
        emit FulfillerAuthorizationUpdated(fulfiller, authorized);
    }

    /**
     * @notice Internal helper to update request timeout
     * @dev Implementing contract should expose public function with access control that calls this
     * @param newTimeout New timeout in seconds
     */
    function _setRequestTimeout(uint256 newTimeout) internal {
        if (newTimeout < 1 days || newTimeout > 30 days) {
            revert InvalidTimeout();
        }
        uint256 oldTimeout = requestTimeout;
        requestTimeout = newTimeout;
        emit RequestTimeoutUpdated(oldTimeout, newTimeout);
    }

    // =============================================================
    //                       VIEW FUNCTIONS
    // =============================================================

    /**
     * @notice Check if a request is pending (exists and not fulfilled)
     * @param requestId The request to check
     * @return isPending True if request exists and is not fulfilled
     */
    function isRequestPending(bytes32 requestId) external view returns (bool isPending) {
        RequestStatus storage request = requests[requestId];
        return request.exists && !request.fulfilled;
    }

    /**
     * @notice Get request status information
     * @param requestId The request to query
     * @return status The request status struct
     */
    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus memory status) {
        return requests[requestId];
    }

    /**
     * @notice Check if an address is an authorized fulfiller
     * @param fulfiller Address to check
     * @return isAuthorized True if address is authorized
     */
    function isFulfillerAuthorized(address fulfiller) external view returns (bool isAuthorized) {
        return authorizedFulfillers[fulfiller];
    }
}
