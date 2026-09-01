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
    error CapMismatch();
    error ZeroCap();
    error VerifierCapExceeded();
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
        uint32[] verifierCaps,
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

    /// @dev KEYED BY (listingHash, funder), NOT BY listingHash ALONE.
    ///
    /// Keying by the hash alone made fund() a free denial of service on every
    /// listing this registry publishes. The payload hash is public BEFORE the
    /// funder escrows against it, by design, so an attacker did not even need
    /// to win a race: read the hash off the API, call fund() with a worthless
    /// token and one unit of it, and the real funder's fund() reverts
    /// AlreadyFunded forever. Nothing clears `funder`, there is no owner and
    /// no recovery, the squatter gets his one unit back after the deadline,
    /// and republishing does not help because the escrow terms are inside the
    /// hash and the squatter takes the new hash too.
    ///
    /// With the funder in the key a squatter occupies only his own slot. The
    /// listing publishes which funder wallet backs it and a reader looks up
    /// exactly that pair, so a stranger's escrow is invisible, not blocking.
    mapping(bytes32 => Listing) private _listings;
    /// @dev cap of 0 means "not a verifier on this listing". Storing the cap
    ///      rather than a bool is also what keeps m-of-n reachable later: a
    ///      threshold scheme needs per-verifier state, and this is that state,
    ///      already indexed the right way.
    mapping(bytes32 => mapping(address => uint32)) private _verifierCap;
    mapping(bytes32 => mapping(address => uint32)) private _verifierUsed;
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

    /// @notice The storage key for one funder's escrow on one listing.
    /// @dev Public and pure so an off-chain reader derives it exactly as this
    ///      contract does rather than reimplementing the rule.
    function escrowKey(bytes32 listingHash, address funder) public pure returns (bytes32) {
        return keccak256(abi.encode(listingHash, funder));
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
        uint32[] calldata verifierCaps,
        uint64 verifierDeadline,
        uint64 claimDeadline
    ) external {
        bytes32 key = escrowKey(listingHash, msg.sender);
        Listing storage l = _listings[key];
        if (l.funder != address(0)) revert AlreadyFunded();
        if (amountPerAward == 0) revert ZeroAmount();
        if (maxAwards == 0) revert ZeroAwards();
        if (verifiers.length == 0) revert NoVerifiers();
        if (token == address(0)) revert ZeroAddress();
        // The worker's claim grace must be strictly positive.
        if (claimDeadline <= verifierDeadline) revert DeadlineOrder();
        if (verifierDeadline <= block.timestamp) revert DeadlineOrder();

        if (verifierCaps.length != verifiers.length) revert CapMismatch();
        for (uint256 i = 0; i < verifiers.length; i++) {
            address v = verifiers[i];
            if (v == address(0)) revert ZeroAddress();
            if (_verifierCap[key][v] != 0) revert DuplicateVerifier();
            // A cap of zero would name a verifier who can do nothing, which is
            // indistinguishable from not naming them and is more likely a
            // mistake than an intent. A cap ABOVE maxAwards is allowed and
            // simply means "this verifier may authorize all of them": it is
            // capped by capacity anyway, and refusing it would make the common
            // single-verifier case a two-value coincidence to get right.
            if (verifierCaps[i] == 0) revert ZeroCap();
            _verifierCap[key][v] = verifierCaps[i];
        }

        l.funder = msg.sender;
        l.token = token;
        l.amountPerAward = amountPerAward;
        l.maxAwards = maxAwards;
        l.verifierDeadline = verifierDeadline;
        l.claimDeadline = claimDeadline;

        uint256 total = amountPerAward * uint256(maxAwards);
        emit Funded(listingHash, msg.sender, token, amountPerAward, maxAwards, verifiers, verifierCaps, verifierDeadline, claimDeadline);
        _pullExact(token, msg.sender, total);
    }

    // --------------------------------------------------------------- release
    /// @notice Pay one award. Anyone may call this; the signature is the
    ///         authorization, not the caller.
    /// @dev THE TRUST BOUNDARY, STATED PLAINLY. The amount is not a parameter:
    ///      it comes from the immutable terms, so a verifier signature decides
    ///      WHO is paid and never HOW MUCH.
    ///
    ///      It does NOT follow that a compromised verifier can misdirect only
    ///      one award. Award ids are chosen by the signer, so a verifier
    ///      holding a key can sign a distinct id per award and authorize every
    ///      award it is allowed, one fixed amount at a time. A verifier whose
    ///      cap equals maxAwards can therefore direct the ENTIRE committed
    ///      balance to an address of its choosing.
    ///
    ///      That is what `verifierCap` bounds: each verifier is fixed at
    ///      funding time to a maximum number of awards it may ever authorize
    ///      on this listing. A funder who names one verifier with the full cap
    ///      is choosing to let that verifier control the whole balance, which
    ///      is a legitimate choice for a small listing and must be a choice
    ///      rather than a surprise.
    function release(
        bytes32 listingHash,
        address funder,
        bytes32 awardId,
        bytes32 submissionHash,
        address payee,
        bytes32 verdictHash,
        uint64 issuedAt,
        bytes calldata signature
    ) external {
        bytes32 esc = escrowKey(listingHash, funder);
        Listing storage l = _listings[esc];
        if (l.funder == address(0)) revert NotFunded();
        if (payee == address(0)) revert ZeroAddress();
        // DEFENCE IN DEPTH. The deadline windows already make this
        // unreachable, since refund needs block.timestamp > claimDeadline and
        // release needs <=. That argument rests on the clock never going
        // backwards, and one SLOAD is cheaper than depending on it.
        if (l.refunded) revert NothingToRefund();
        // THE TWO WINDOWS, both enforced. The verdict must have been issued
        // within the verifier's window, and the claim must be relayed within
        // the worker's. Because claimDeadline is strictly greater, a verifier
        // who signs at the last possible second still leaves the worker the
        // whole grace period to collect: verifier delay cannot consume the
        // window that belongs to the payee.
        if (issuedAt > l.verifierDeadline) revert VerifierWindowClosed();
        if (block.timestamp > l.claimDeadline) revert ClaimWindowClosed();

        bytes32 awardKey = keccak256(abi.encode(esc, awardId));
        if (paid[awardKey]) revert AwardAlreadyPaid();
        if (l.released >= l.maxAwards) revert NoCapacity();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _DOMAIN_SEPARATOR,
                keccak256(abi.encode(_RELEASE_TYPEHASH, listingHash, awardId, submissionHash, payee, verdictHash, issuedAt))
            )
        );
        address signer = _recover(digest, signature);
        uint32 cap = _verifierCap[esc][signer];
        if (cap == 0) revert NotAVerifier();
        // THE BLAST RADIUS OF ONE COMPROMISED KEY. Without this, a verifier
        // could mint a distinct award id per award and walk the whole balance
        // out one fixed amount at a time.
        if (_verifierUsed[esc][signer] >= cap) revert VerifierCapExceeded();

        // EFFECTS BEFORE INTERACTION. Both the per-award flag and the counter
        // are written before the transfer, so a token with a callback cannot
        // re-enter and pay the same award twice or exceed maxAwards.
        paid[awardKey] = true;
        l.released += 1;
        _verifierUsed[esc][signer] += 1;

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
    function refund(bytes32 listingHash, address funder) external {
        Listing storage l = _listings[escrowKey(listingHash, funder)];
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
    function listingOf(bytes32 listingHash, address fundedBy)
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
        Listing storage l = _listings[escrowKey(listingHash, fundedBy)];
        return (
            l.funder,
            l.token,
            l.amountPerAward,
            l.maxAwards,
            l.released,
            l.verifierDeadline,
            l.claimDeadline,
            l.refunded,
            // A REFUNDED LISTING HOLDS NOTHING, and this view used to say
            // otherwise: it reported the full remainder after the money had
            // gone back to the funder. An off-chain reader that trusted it
            // would print "FUNDED, N committed" about an empty escrow.
            l.refunded ? 0 : uint256(l.maxAwards - l.released) * l.amountPerAward
        );
    }

    /// @return cap how many awards this verifier may EVER authorize here, 0 if none
    /// @return used how many it has authorized so far
    function verifierAuthority(bytes32 listingHash, address funder, address who) external view returns (uint32 cap, uint32 used) {
        bytes32 esc = escrowKey(listingHash, funder);
        return (_verifierCap[esc][who], _verifierUsed[esc][who]);
    }

    function isVerifier(bytes32 listingHash, address funder, address who) external view returns (bool) {
        return _verifierCap[escrowKey(listingHash, funder)][who] != 0;
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
