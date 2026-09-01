// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ListingEscrow} from "../src/ListingEscrow.sol";

contract MockUSDC {
    string public name = "USD Coin";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external virtual returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external virtual returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Takes a 1% cut. The escrow must REFUSE it rather than under-fund the last worker.
contract FeeToken is MockUSDC {
    function transferFrom(address f, address t, uint256 a) external override returns (bool) {
        uint256 fee = a / 100;
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a - fee; return true;
    }
}

/// Tries to re-enter release() during the payout.
contract ReenterToken is MockUSDC {
    ListingEscrow public escrow;
    bytes public payload;
    bool public armed;
    function arm(ListingEscrow e, bytes calldata p) external { escrow = e; payload = p; armed = true; }
    function transfer(address to, uint256 a) external override returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
        if (armed) { armed = false; (bool ok,) = address(escrow).call(payload); ok; }
        return true;
    }
}

contract ListingEscrowTest is Test {
    ListingEscrow escrow;
    MockUSDC usdc;

    uint256 verifierKey = 0xA11CE;
    address verifier;
    address funder = address(0xF00D);
    address payee = address(0xBEEF);
    address relayer = address(0x4E1A4);

    bytes32 constant LH = keccak256("listing-20-payload-hash");
    uint64 vDeadline;
    uint64 cDeadline;

    function setUp() public {
        escrow = new ListingEscrow();
        usdc = new MockUSDC();
        verifier = vm.addr(verifierKey);
        vDeadline = uint64(block.timestamp + 7 days);
        cDeadline = uint64(block.timestamp + 37 days);
        usdc.mint(funder, 1_000_000_000);
        // Pranked senders need gas when this suite is run against a fork; on
        // the default in-memory chain it costs nothing and changes nothing.
        vm.deal(funder, 1 ether);
        vm.deal(relayer, 1 ether);
        vm.deal(payee, 1 ether);
        vm.prank(funder);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _fund(uint256 per, uint32 max) internal {
        _fundCapped(per, max, max);
    }

    /// The single-verifier case with an explicit cap, which is the shape the
    /// first real listing will use.
    function _fundCapped(uint256 per, uint32 max, uint32 cap) internal {
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = cap;
        vm.prank(funder);
        escrow.fund(LH, address(usdc), per, max, vs, caps, vDeadline, cDeadline);
    }

    function _releaseBy(uint256 key, uint256 id) internal {
        uint64 t = uint64(block.timestamp);
        escrow.release(LH, funder, bytes32(id), bytes32(0), payee, bytes32(0), t, _sig(LH, bytes32(id), bytes32(0), payee, bytes32(0), t, key));
    }

    function _sig(bytes32 listingHash, bytes32 awardId, bytes32 subHash, address to, bytes32 verdictHash, uint64 issuedAt, uint256 key)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Release(bytes32 listingHash,address funder,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)"),
            listingHash, funder, awardId, subHash, to, verdictHash, issuedAt
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ the basics

    function test_fund_commits_the_maximum_liability_not_one_award() public {
        _fund(5_000_000, 3);
        assertEq(usdc.balanceOf(address(escrow)), 15_000_000, "the whole ceiling is committed at publication");
        (,,,,,,,, uint256 committed) = escrow.listingOf(LH, funder);
        assertEq(committed, 15_000_000);
    }

    function test_anyone_may_relay_a_valid_release_and_the_payee_gets_paid() public {
        _fund(5_000_000, 3);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(uint256(9)), payee, bytes32(uint256(7)), uint64(block.timestamp), verifierKey);
        vm.prank(relayer); // NOT the payee, NOT the funder, NOT any registry
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(uint256(9)), payee, bytes32(uint256(7)), uint64(block.timestamp), sig);
        assertEq(usdc.balanceOf(payee), 5_000_000, "the signature is the authorization, not the caller");
    }

    // -------------------------------------------------- the custody property

    function test_NOBODY_can_move_funds_without_a_verifier_signature() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        // A stranger's signature.
        bytes memory bad = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, 0xBADBEEF);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, bad);
        // The FUNDER cannot self-release either: funding does not make you a verifier.
        bytes memory byFunder = _sig(LH, bytes32(uint256(1)), bytes32(0), funder, bytes32(0), t, uint256(uint160(funder)));
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        vm.prank(funder);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), funder, bytes32(0), t, byFunder);
        assertEq(usdc.balanceOf(address(escrow)), 15_000_000, "not one atom moved");
    }

    function test_a_verifier_signature_decides_WHO_never_HOW_MUCH() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
        // The amount is not a parameter anywhere in the call. A fully
        // compromised verifier can misdirect ONE award and can never drain.
        assertEq(usdc.balanceOf(payee), 5_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 10_000_000);
    }

    // ------------------------------------------------ THE TRUST BOUNDARY
    //
    // The claim "a compromised verifier can misdirect one award and can never
    // drain the escrow" was FALSE and these tests exist because of it. Award
    // ids are chosen by the signer, so a verifier holding a key can mint a
    // fresh id per award and walk out the entire balance one fixed amount at a
    // time. What bounds it is the per-verifier cap, and nothing else.

    function test_UNCAPPED_VERIFIER_CAN_DRAIN_THE_WHOLE_LISTING() public {
        // A funder who gives one verifier the full cap is choosing this. The
        // test exists so the choice is documented and measured rather than
        // discovered later by someone it happened to.
        _fundCapped(5_000_000, 3, 3);
        address attacker = address(0xBAD);
        uint64 t = uint64(block.timestamp);
        for (uint256 i = 1; i <= 3; i++) {
            bytes memory sig = _sig(LH, bytes32(i), bytes32(0), attacker, bytes32(0), t, verifierKey);
            escrow.release(LH, funder, bytes32(i), bytes32(0), attacker, bytes32(0), t, sig);
        }
        assertEq(usdc.balanceOf(attacker), 15_000_000, "one key, every award, the entire committed balance");
        assertEq(usdc.balanceOf(address(escrow)), 0);
        // And it stops exactly at the ceiling: capacity is still a hard limit.
        bytes memory fourth = _sig(LH, bytes32(uint256(4)), bytes32(0), attacker, bytes32(0), t, verifierKey);
        vm.expectRevert(ListingEscrow.NoCapacity.selector);
        escrow.release(LH, funder, bytes32(uint256(4)), bytes32(0), attacker, bytes32(0), t, fourth);
    }

    function test_a_capped_verifier_is_bounded_to_its_declared_authority() public {
        // The same attack, against a verifier capped at one award of three.
        _fundCapped(5_000_000, 3, 1);
        address attacker = address(0xBAD);
        uint64 t = uint64(block.timestamp);
        bytes memory first = _sig(LH, bytes32(uint256(1)), bytes32(0), attacker, bytes32(0), t, verifierKey);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), attacker, bytes32(0), t, first);
        assertEq(usdc.balanceOf(attacker), 5_000_000);

        // Every further award, under any fresh id, is refused.
        for (uint256 i = 2; i <= 5; i++) {
            bytes memory sig = _sig(LH, bytes32(i), bytes32(0), attacker, bytes32(0), t, verifierKey);
            vm.expectRevert(ListingEscrow.VerifierCapExceeded.selector);
            escrow.release(LH, funder, bytes32(i), bytes32(0), attacker, bytes32(0), t, sig);
        }
        assertEq(usdc.balanceOf(attacker), 5_000_000, "the blast radius is the declared cap and nothing more");
        assertEq(usdc.balanceOf(address(escrow)), 10_000_000, "the rest is still there for honest awards");
        (uint32 cap, uint32 used) = escrow.verifierAuthority(LH, funder, verifier);
        assertEq(cap, 1);
        assertEq(used, 1);
    }

    function test_two_verifiers_each_bounded_separately() public {
        // Storage is per verifier, which is also what makes m-of-n reachable
        // later without moving anything.
        uint256 keyB = 0xB0B;
        address vb = vm.addr(keyB);
        address[] memory vs = new address[](2);
        uint32[] memory caps = new uint32[](2);
        vs[0] = verifier; caps[0] = 1;
        vs[1] = vb;       caps[1] = 2;
        vm.prank(funder);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, vDeadline, cDeadline);
        uint64 t = uint64(block.timestamp);

        _releaseBy(verifierKey, 1);
        bytes memory over = _sig(LH, bytes32(uint256(2)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.expectRevert(ListingEscrow.VerifierCapExceeded.selector);
        escrow.release(LH, funder, bytes32(uint256(2)), bytes32(0), payee, bytes32(0), t, over);

        // The other verifier's authority is untouched by the first's exhaustion.
        _releaseBy(keyB, 2);
        _releaseBy(keyB, 3);
        assertEq(usdc.balanceOf(payee), 15_000_000);
        (, uint32 usedB) = escrow.verifierAuthority(LH, funder, vb);
        assertEq(usedB, 2);
    }

    function test_a_zero_cap_verifier_cannot_be_named() public {
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier; caps[0] = 0;
        vm.prank(funder);
        vm.expectRevert(ListingEscrow.ZeroCap.selector);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, vDeadline, cDeadline);
    }

    function test_caps_must_be_supplied_for_every_verifier() public {
        address[] memory vs = new address[](2);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier; vs[1] = address(0xB0B); caps[0] = 1;
        vm.prank(funder);
        vm.expectRevert(ListingEscrow.CapMismatch.selector);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, vDeadline, cDeadline);
    }

    /// Whatever the caps are, the sum of what all verifiers can authorize is
    /// still bounded by capacity: caps limit WHO can do how much, never how
    /// much the listing can cost.
    function testFuzz_caps_never_let_a_listing_exceed_its_ceiling(uint32 capA, uint8 awards) public {
        awards = uint8(bound(awards, 1, 8));
        capA = uint32(bound(capA, 1, 100));
        usdc.mint(funder, uint256(5_000_000) * awards);
        _fundCapped(5_000_000, awards, capA);
        uint64 t = uint64(block.timestamp);
        uint256 paidOut;
        for (uint256 i = 1; i <= 12; i++) {
            bytes memory sig = _sig(LH, bytes32(i), bytes32(0), payee, bytes32(0), t, verifierKey);
            try escrow.release(LH, funder, bytes32(i), bytes32(0), payee, bytes32(0), t, sig) { paidOut += 5_000_000; } catch { }
        }
        uint256 allowed = capA < awards ? capA : awards;
        assertEq(paidOut, uint256(5_000_000) * allowed, "released is min(cap, capacity), always");
        assertLe(paidOut, uint256(5_000_000) * awards, "and never more than the listing committed");
    }

    // ------------------------------------------- INDEPENDENT AUDIT FINDINGS

    /// HIGH, from the independent review: fund() was permissionless and keyed
    /// by listingHash alone, so anyone could read a published hash off the API
    /// and squat it with a worthless token for the price of gas. The real
    /// funder's fund() then reverted AlreadyFunded forever, with no owner and
    /// no recovery, and the squatter got his dust back after the deadline.
    function test_a_squatter_cannot_brick_a_listing() public {
        MockUSDC junk = new MockUSDC();
        address squatter = address(0x5EA7);
        junk.mint(squatter, 1);
        vm.deal(squatter, 1 ether);
        vm.startPrank(squatter);
        junk.approve(address(escrow), 1);
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = squatter; caps[0] = 1;
        // The squatter escrows against the REAL listing hash, for free.
        escrow.fund(LH, address(junk), 1, 1, vs, caps, vDeadline, cDeadline);
        vm.stopPrank();

        // The real funder is unaffected: their escrow is a different key.
        _fund(5_000_000, 3);
        (address who,,,,,,,, uint256 committed) = escrow.listingOf(LH, funder);
        assertEq(who, funder, "the listing a reader looks up is the one its funder backed");
        assertEq(committed, 15_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 15_000_000);

        // And the squatter's escrow is visible only to someone who asks for
        // it by his address, which no reader of this listing does.
        (address sq,,,,,,,,) = escrow.listingOf(LH, squatter);
        assertEq(sq, squatter);
        // His verifier authority does not reach the real funder's escrow.
        assertEq(escrow.isVerifier(LH, funder, squatter), false, "a squatter authorizes nothing on the listing that matters");
    }

    /// HIGH, found on re-review: my own fix for the squat opened this. Keying
    /// escrows by (listingHash, funder) made listingHash name a FAMILY of
    /// escrows while the signed digest still covered only the hash, so the
    /// RELAYER chose whose money a verifier's signature moved.
    ///
    /// The attack: escrow the same listing with a token you minted yourself,
    /// solicit verdicts against that visibly worthless escrow, then replay
    /// each signature byte for byte onto the honest funder's escrow, where the
    /// award id is fresh and the verifier's cap is a separate counter. The
    /// verifier believed it was authorizing 3 junk units and authorized $15.
    function test_a_signature_cannot_be_replayed_onto_another_funders_escrow() public {
        _fundCapped(5_000_000, 3, 3);              // the honest funder
        MockUSDC junk = new MockUSDC();            // the decoy
        address attacker = address(0xDEC0);
        junk.mint(attacker, 3);
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        junk.approve(address(escrow), 3);
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;                          // the SAME verifier the listing names
        caps[0] = 3;
        escrow.fund(LH, address(junk), 1, 3, vs, caps, vDeadline, cDeadline);
        vm.stopPrank();

        // The verifier signs a verdict for the DECOY escrow, in good faith.
        uint64 t = uint64(block.timestamp);
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Release(bytes32 listingHash,address funder,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)"),
            LH, attacker, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t
        ));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(verifierKey, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash)));
        bytes memory decoySig = abi.encodePacked(r, sg, v);

        // It spends the decoy, which is what the verifier agreed to.
        escrow.release(LH, attacker, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, decoySig);
        assertEq(junk.balanceOf(payee), 1, "the escrow the verifier actually looked at");

        // AND IT CANNOT BE REPLAYED ONTO THE HONEST FUNDER'S ESCROW. The
        // funder is inside the signed bytes, so this recovers a different
        // address entirely.
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, decoySig);
        assertEq(usdc.balanceOf(address(escrow)), 15_000_000, "not one atom of the honest listing moved");
        (, uint32 used) = escrow.verifierAuthority(LH, funder, verifier);
        assertEq(used, 0, "and the verifier spent none of its authority there");
    }

    /// MEDIUM: listingOf().committed reported the full remainder after a
    /// refund had already returned the money, so a reader would print
    /// "FUNDED, N committed" about an empty escrow.
    function test_committed_is_zero_once_the_money_has_gone_back() public {
        _fund(5_000_000, 3);
        vm.warp(cDeadline + 1);
        escrow.refund(LH, funder);
        (,,,,,,, bool refunded_, uint256 committed) = escrow.listingOf(LH, funder);
        assertEq(refunded_, true);
        assertEq(committed, 0, "a view that reports money the escrow does not hold is a lie a reader will repeat");
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// The deadline windows already make this unreachable; the check removes
    /// a single-point dependency on the clock never going backwards.
    function test_release_after_a_refund_is_refused_even_if_the_clock_moves_back() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.warp(cDeadline + 1);
        escrow.refund(LH, funder);
        // A clock that went backwards would reopen the claim window.
        vm.warp(cDeadline - 1);
        vm.expectRevert(ListingEscrow.NothingToRefund.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
        assertEq(usdc.balanceOf(payee), 0);
    }

    /// The log is the record this society reads. With several escrows per
    /// listing hash, a reader indexing by hash alone conflates them and cannot
    /// attribute a payment or rebuild `released` per escrow, so the funder is
    /// in the event and indexed.
    function test_the_release_log_names_which_escrow_paid() public {
        _fundCapped(5_000_000, 3, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit ListingEscrow.Released(LH, funder, bytes32(uint256(1)), payee, verifier, 5_000_000);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
    }

    // ---------------------------------------------------- double payment

    function test_one_award_cannot_be_paid_twice() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
        vm.expectRevert(ListingEscrow.AwardAlreadyPaid.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
    }

    function test_capacity_is_a_hard_ceiling() public {
        _fund(5_000_000, 2);
        uint64 t = uint64(block.timestamp);
        for (uint256 i = 1; i <= 2; i++) {
            bytes memory s = _sig(LH, bytes32(i), bytes32(0), payee, bytes32(0), t, verifierKey);
            escrow.release(LH, funder, bytes32(i), bytes32(0), payee, bytes32(0), t, s);
        }
        bytes memory third = _sig(LH, bytes32(uint256(3)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.expectRevert(ListingEscrow.NoCapacity.selector);
        escrow.release(LH, funder, bytes32(uint256(3)), bytes32(0), payee, bytes32(0), t, third);
    }

    function test_a_signature_cannot_be_replayed_onto_another_listing() public {
        _fund(5_000_000, 3);
        bytes32 other = keccak256("a different listing");
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 1;
        vm.prank(funder);
        escrow.fund(other, address(usdc), 5_000_000, 1, vs, caps, vDeadline, cDeadline);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector); // recovers a different address entirely
        escrow.release(other, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
    }

    function test_signature_is_bound_to_the_payee() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), address(0xDEAD), bytes32(0), t, sig);
    }

    // ------------------------------------------------------- the two windows

    function test_verifier_delay_cannot_steal_the_workers_claim_window() public {
        _fund(5_000_000, 3);
        // The verifier signs at the LAST legal instant of their window.
        uint64 t = vDeadline;
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        // The worker still has the whole grace period to collect.
        vm.warp(cDeadline);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
        assertEq(usdc.balanceOf(payee), 5_000_000, "the grace window belongs to the payee and no verifier can consume it");
    }

    function test_a_verdict_issued_after_the_verifier_window_is_refused() public {
        _fund(5_000_000, 3);
        uint64 late = vDeadline + 1;
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), late, verifierKey);
        vm.expectRevert(ListingEscrow.VerifierWindowClosed.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), late, sig);
    }

    function test_release_after_the_claim_deadline_is_refused() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        vm.warp(cDeadline + 1);
        vm.expectRevert(ListingEscrow.ClaimWindowClosed.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
    }

    /// SURVIVOR from the first mutation sweep: deleting the ordering check
    /// changed nothing any test could see, because every test funded with
    /// sensible deadlines. The check is what GUARANTEES the worker a grace
    /// period at all; without it a funder can set both clocks to the same
    /// instant and a verifier who signs at their deadline leaves the payee
    /// zero seconds to collect, with the refund opening immediately.
    function test_a_listing_MUST_leave_the_worker_a_claim_grace() public {
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 3;
        vm.startPrank(funder);
        // Same instant: no grace at all.
        vm.expectRevert(ListingEscrow.DeadlineOrder.selector);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, vDeadline, vDeadline);
        // Claim window closing BEFORE the verifier window is worse still.
        vm.expectRevert(ListingEscrow.DeadlineOrder.selector);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, vDeadline, vDeadline - 1);
        // A verifier deadline already in the past cannot be funded either.
        vm.expectRevert(ListingEscrow.DeadlineOrder.selector);
        escrow.fund(LH, address(usdc), 5_000_000, 3, vs, caps, uint64(block.timestamp), cDeadline);
        vm.stopPrank();
        (address f,,,,,,,,) = escrow.listingOf(LH, funder);
        assertEq(f, address(0), "none of those listings exist");
    }

    function testFuzz_any_funded_listing_leaves_a_positive_claim_grace(uint64 v, uint64 c) public {
        v = uint64(bound(v, block.timestamp + 1, block.timestamp + 3650 days));
        c = uint64(bound(c, block.timestamp, block.timestamp + 7300 days));
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 1;
        vm.prank(funder);
        if (c <= v) {
            vm.expectRevert(ListingEscrow.DeadlineOrder.selector);
            escrow.fund(LH, address(usdc), 1_000_000, 1, vs, caps, v, c);
        } else {
            escrow.fund(LH, address(usdc), 1_000_000, 1, vs, caps, v, c);
            (,,,,, uint64 vd, uint64 cd,,) = escrow.listingOf(LH, funder);
            assertGt(cd, vd, "every funded listing has a grace window that belongs to the payee");
        }
    }

    // -------------------------------------------------------------- refunds

    function test_no_early_cancellation_by_the_funder() public {
        _fund(5_000_000, 3);
        vm.prank(funder);
        vm.expectRevert(ListingEscrow.ClaimWindowOpen.selector);
        escrow.refund(LH, funder);
    }

    function test_refund_returns_only_the_unreleased_remainder_and_only_to_the_funder() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, sig);
        vm.warp(cDeadline + 1);
        uint256 before = usdc.balanceOf(funder);
        vm.prank(relayer); // anyone may call it; the destination is not a parameter
        escrow.refund(LH, funder);
        assertEq(usdc.balanceOf(funder) - before, 10_000_000, "two unused awards return, the paid one does not");
        assertEq(usdc.balanceOf(relayer), 0, "and the caller gets nothing");
    }

    function test_refund_cannot_be_taken_twice() public {
        _fund(5_000_000, 1);
        vm.warp(cDeadline + 1);
        escrow.refund(LH, funder);
        vm.expectRevert(ListingEscrow.NothingToRefund.selector);
        escrow.refund(LH, funder);
    }

    // ------------------------------------------------------ hostile tokens

    function test_a_fee_on_transfer_token_is_REFUSED_not_approximated() public {
        FeeToken fee = new FeeToken();
        fee.mint(funder, 100_000_000);
        vm.prank(funder);
        fee.approve(address(escrow), type(uint256).max);
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 3;
        vm.prank(funder);
        vm.expectRevert(ListingEscrow.TokenNotExact.selector);
        escrow.fund(LH, address(fee), 5_000_000, 3, vs, caps, vDeadline, cDeadline);
    }

    function test_reentrancy_during_payout_cannot_pay_the_same_award_twice() public {
        ReenterToken t = new ReenterToken();
        t.mint(funder, 100_000_000);
        vm.prank(funder);
        t.approve(address(escrow), type(uint256).max);
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 3;
        vm.prank(funder);
        escrow.fund(LH, address(t), 5_000_000, 3, vs, caps, vDeadline, cDeadline);

        uint64 ts = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), ts, verifierKey);
        bytes memory reentry = abi.encodeCall(
            ListingEscrow.release, (LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), ts, sig)
        );
        t.arm(escrow, reentry);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), ts, sig);
        assertEq(t.balanceOf(payee), 5_000_000, "paid exactly once despite the callback");
    }

    // ------------------------------------------------------------ signatures

    function test_malleable_signatures_are_refused() public {
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, verifierKey);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        uint256 flipped = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s);
        bytes memory malleable = abi.encodePacked(r, bytes32(flipped), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(ListingEscrow.BadSignature.selector);
        escrow.release(LH, funder, bytes32(uint256(1)), bytes32(0), payee, bytes32(0), t, malleable);
    }

    // ----------------------------------------------------------------- fuzz

    /// THE SOLVENCY INVARIANT, fuzzed: whatever sequence of releases happens,
    /// the escrow always holds exactly what it still owes.
    function testFuzz_escrow_always_holds_exactly_its_remaining_obligation(uint96 per, uint8 awards, uint8 toRelease) public {
        per = uint96(bound(per, 1, 1e12));
        awards = uint8(bound(awards, 1, 20));
        toRelease = uint8(bound(toRelease, 0, awards));
        usdc.mint(funder, uint256(per) * awards);
        _fund(per, awards);
        uint64 t = uint64(block.timestamp);
        for (uint256 i = 1; i <= toRelease; i++) {
            bytes memory s = _sig(LH, bytes32(i), bytes32(0), payee, bytes32(0), t, verifierKey);
            escrow.release(LH, funder, bytes32(i), bytes32(0), payee, bytes32(0), t, s);
        }
        (,,,,,,,, uint256 committed) = escrow.listingOf(LH, funder);
        assertEq(usdc.balanceOf(address(escrow)), committed, "held == owed, always");
        assertEq(usdc.balanceOf(payee), uint256(per) * toRelease);
    }

    /// No signature from a non-verifier key, over any award, ever pays.
    function testFuzz_only_the_named_verifier_can_authorize(uint256 key, bytes32 awardId) public {
        key = bound(key, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(vm.addr(key) != verifier);
        _fund(5_000_000, 3);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(LH, awardId, bytes32(0), payee, bytes32(0), t, key);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(LH, funder, awardId, bytes32(0), payee, bytes32(0), t, sig);
        assertEq(usdc.balanceOf(address(escrow)), 15_000_000);
    }
}
