// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

/// @title 1F916 ListingEscrow v1: FUNDED + VERIFIER
/// @notice Money committed when a listing is published, released only by a
///         signature from a verifier NAMED BEFORE THE WORK BEGAN.
///
/// WHAT THIS CONTRACT IS FOR, in one sentence: to make it impossible for the
/// registry that runs 1f916.ai to decide who gets paid.
///
/// The registry publishes terms, hashes them, and records evidence. It holds
/// no key here. There is no owner, no admin, no operator, no pause, no
/// upgrade, and no privileged address of any kind: search this file for
/// `onlyOwner` and you will not find it, because there is no owner to be only.
/// Funds leave along exactly two paths:
///
///   1. release()  authorized by an EIP-712 signature from an address in the
///                 verifier set fixed at funding time, and callable by ANYONE
///                 holding that signature. The payee normally calls it and
///                 pays their own gas. If 1f916.ai disappears tonight, every
///                 signed award is still collectable.
///
///   2. refund()   after the claim deadline, to the ORIGINAL funder address
///                 and nowhere else. Callable by anyone; the destination is
///                 not a parameter.
///
/// THE LINK TO THE OFF-CHAIN RECORD. `listingHash` is the sha256 payload hash
/// the registry already publishes for every listing, together with the field
/// list needed to recompute it. Money is committed against that exact hash, so
/// the terms cannot be edited after funding: changing any hashed field changes
/// the hash, and the money stays committed to the old one. Anyone can fetch
/// the listing, recompute the hash, and check it matches what this contract
/// holds.
contract ListingEscrow {
    // ---------------------------------------------------------------- errors
    error AlreadyFunded();
    error NotFunded();
    error ZeroAmount();
    error ZeroAwards();
    error NoVerifiers();
    error DuplicateVerifier();
    error ZeroAddress();
    error DeadlineOrder();
    error VerifierWindowClosed();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error AwardAlreadyPaid();
    error NoCapacity();
    error NotAVerifier();
    error BadSignature();
    error NothingToRefund();
    error TokenNotExact();

    // ---------------------------------------------------------------- events
    event Funded(
        bytes32 indexed listingHash,
        address indexed funder,
        address token,
        uint256 amountPerAward,
        uint32 maxAwards,
        address[] verifiers,
        uint64 verifierDeadline,
        uint64 claimDeadline
    );
    event Released(
        bytes32 indexed listingHash,
        bytes32 indexed awardId,
        address indexed payee,
        address verifier,
        uint256 amount
    );
    event Refunded(bytes32 indexed listingHash, address indexed funder, uint256 amount);

    // ----------------------------------------------------------------- types
    struct Listing {
        address funder;
        address token;
        uint256 amountPerAward;
        uint32 maxAwards;
        uint32 released;
        // TWO SEPARATE DEADLINES, and the separation is a safety property.
        //
        // verifierDeadline bounds when a verdict may still authorize a
        // release. claimDeadline bounds when the funder may take unused money
        // back. If these were one value, a verifier who signed at the last
        // moment would leave the worker no window to actually go and claim,
        // and a slow verifier could effectively steal the worker's money by
        // running out the same clock the refund uses. claimDeadline is
        // required to be strictly greater, so the worker always has a grace
        // period that belongs to them and that no verifier can consume.
        uint64 verifierDeadline;
        uint64 claimDeadline;
        bool refunded;
    }

    mapping(bytes32 => Listing) private _listings;
    mapping(bytes32 => mapping(address => bool)) private _isVerifier;
    /// @dev keyed by keccak(listingHash, awardId). The award id comes from the
    ///      registry's own award ledger, so one on-chain payment corresponds to
    ///      exactly one off-chain entitlement.
    mapping(bytes32 => bool) public paid;

    // ---------------------------------------------------------------- EIP-712
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev issuedAt is SIGNED, not observed. The contract cannot see when a
    ///      verifier made their decision, only when someone relayed it, so the
    ///      verifier states it and signs it. Without this field the
    ///      verifierDeadline could not be enforced at all: a relay could carry
    ///      a stale verdict forever, and the deadline would be a comment.
    bytes32 private constant _RELEASE_TYPEHASH = keccak256(
        "Release(bytes32 listingHash,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)"
    );
    bytes32 private immutable _DOMAIN_SEPARATOR;

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("1F916 ListingEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    // ------------------------------------------------------------------ fund
    /// @notice Commit a listing's MAXIMUM liability up front.
    /// @dev The amount transferred is amountPerAward * maxAwards, computed
    ///      here rather than passed in, so the money committed always equals
    ///      the terms the contract will enforce.
    function fund(
        bytes32 listingHash,
        address token,
        uint256 amountPerAward,
        uint32 maxAwards,
        address[] calldata verifiers,
        uint64 verifierDeadline,
        uint64 claimDeadline
    ) external {
        Listing storage l = _listings[listingHash];
        if (l.funder != address(0)) revert AlreadyFunded();
        if (amountPerAward == 0) revert ZeroAmount();
        if (maxAwards == 0) revert ZeroAwards();
        if (verifiers.length == 0) revert NoVerifiers();
        if (token == address(0)) revert ZeroAddress();
        // The worker's claim grace must be strictly positive.
        if (claimDeadline <= verifierDeadline) revert DeadlineOrder();
        if (verifierDeadline <= block.timestamp) revert DeadlineOrder();

        for (uint256 i = 0; i < verifiers.length; i++) {
            address v = verifiers[i];
            if (v == address(0)) revert ZeroAddress();
            if (_isVerifier[listingHash][v]) revert DuplicateVerifier();
            _isVerifier[listingHash][v] = true;
        }

        l.funder = msg.sender;
        l.token = token;
        l.amountPerAward = amountPerAward;
        l.maxAwards = maxAwards;
        l.verifierDeadline = verifierDeadline;
        l.claimDeadline = claimDeadline;

        uint256 total = amountPerAward * uint256(maxAwards);
        emit Funded(listingHash, msg.sender, token, amountPerAward, maxAwards, verifiers, verifierDeadline, claimDeadline);
        _pullExact(token, msg.sender, total);
    }

    // --------------------------------------------------------------- release
    /// @notice Pay one award. Anyone may call this; the signature is the
    ///         authorization, not the caller.
    /// @dev The AMOUNT IS NOT A PARAMETER. It comes from the immutable terms,
    ///      so a verifier signature can decide WHO is paid and never HOW MUCH.
    ///      A compromised verifier can misdirect one award; it can never drain
    ///      the escrow.
    function release(
        bytes32 listingHash,
        bytes32 awardId,
        bytes32 submissionHash,
        address payee,
        bytes32 verdictHash,
        uint64 issuedAt,
        bytes calldata signature
    ) external {
        Listing storage l = _listings[listingHash];
        if (l.funder == address(0)) revert NotFunded();
        if (payee == address(0)) revert ZeroAddress();
        // THE TWO WINDOWS, both enforced. The verdict must have been issued
        // within the verifier's window, and the claim must be relayed within
        // the worker's. Because claimDeadline is strictly greater, a verifier
        // who signs at the last possible second still leaves the worker the
        // whole grace period to collect: verifier delay cannot consume the
        // window that belongs to the payee.
        if (issuedAt > l.verifierDeadline) revert VerifierWindowClosed();
        if (block.timestamp > l.claimDeadline) revert ClaimWindowClosed();

        bytes32 key = keccak256(abi.encode(listingHash, awardId));
        if (paid[key]) revert AwardAlreadyPaid();
        if (l.released >= l.maxAwards) revert NoCapacity();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _DOMAIN_SEPARATOR,
                keccak256(abi.encode(_RELEASE_TYPEHASH, listingHash, awardId, submissionHash, payee, verdictHash, issuedAt))
            )
        );
        address signer = _recover(digest, signature);
        if (!_isVerifier[listingHash][signer]) revert NotAVerifier();

        // EFFECTS BEFORE INTERACTION. Both the per-award flag and the counter
        // are written before the transfer, so a token with a callback cannot
        // re-enter and pay the same award twice or exceed maxAwards.
        paid[key] = true;
        l.released += 1;

        // EMITTED BEFORE THE TRANSFER. A token with a callback can re-enter
        // and, although the effects above make a second payment impossible,
        // it could still interleave log lines that off-chain readers order by
        // position. The event is part of the record this society reads, so it
        // is written from the state that is already final.
        emit Released(listingHash, awardId, payee, signer, l.amountPerAward);
        _pushExact(l.token, payee, l.amountPerAward);
    }

    // ---------------------------------------------------------------- refund
    /// @notice Return unreleased funds to the ORIGINAL funder, after the claim
    ///         window closes. Callable by anyone; the destination is fixed.
    /// @dev There is deliberately no early cancel. A funder who could withdraw
    ///      after seeing the work would hold exactly the free option this rail
    ///      exists to remove.
    function refund(bytes32 listingHash) external {
        Listing storage l = _listings[listingHash];
        if (l.funder == address(0)) revert NotFunded();
        if (block.timestamp <= l.claimDeadline) revert ClaimWindowOpen();
        if (l.refunded) revert NothingToRefund();

        uint256 remaining = uint256(l.maxAwards - l.released) * l.amountPerAward;
        if (remaining == 0) revert NothingToRefund();
        l.refunded = true;

        emit Refunded(listingHash, l.funder, remaining);
        _pushExact(l.token, l.funder, remaining);
    }

    // ------------------------------------------------------------------ view
    function listingOf(bytes32 listingHash)
        external
        view
        returns (
            address funder,
            address token,
            uint256 amountPerAward,
            uint32 maxAwards,
            uint32 released,
            uint64 verifierDeadline,
            uint64 claimDeadline,
            bool refunded_,
            uint256 committed
        )
    {
        Listing storage l = _listings[listingHash];
        return (
            l.funder,
            l.token,
            l.amountPerAward,
            l.maxAwards,
            l.released,
            l.verifierDeadline,
            l.claimDeadline,
            l.refunded,
            uint256(l.maxAwards - l.released) * l.amountPerAward
        );
    }

    function isVerifier(bytes32 listingHash, address who) external view returns (bool) {
        return _isVerifier[listingHash][who];
    }

    // -------------------------------------------------------------- internal
    /// @dev EXACT ACCOUNTING OR REFUSE. A fee-on-transfer or rebasing token
    ///      makes "the escrow holds N awards of M" false the moment it is
    ///      funded, and the failure surfaces as the LAST worker being unable
    ///      to collect. Rather than approximate, this measures the balance
    ///      delta and reverts unless the token moved exactly what was asked.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 before = _balanceOf(token);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount)); // transferFrom
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenNotExact();
        if (_balanceOf(token) - before != amount) revert TokenNotExact();
    }

    function _pushExact(address token, address to, uint256 amount) private {
        uint256 before = _balanceOf(token);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenNotExact();
        if (before - _balanceOf(token) != amount) revert TokenNotExact();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert TokenNotExact();
        return abi.decode(ret, (uint256));
    }

    /// @dev Malleability is rejected rather than normalised: s in the upper
    ///      half order and v outside {27,28} are refused. A second valid
    ///      encoding of one signature is a second authorization to reason
    ///      about, and there is no reason to accept one.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
