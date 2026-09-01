// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ListingEscrow} from "../src/ListingEscrow.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// END TO END ON BASE SEPOLIA, against the real USDC contract Circle deploys
/// there (0x036CbD53842c5426634e7929541eC2318f3dCF7e), not a mock. Run with
/// --fork-url. Every negative case the owner asked for is here beside the
/// happy path, because the happy path is the easy half.
contract SepoliaE2ETest is Test {
    IERC20 usdc = IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    ListingEscrow escrow;

    uint256 verifierKey = 0xA11CE;
    uint256 strangerKey = 0xBADBEEF;
    address verifier;
    address funder = address(0x1F916f00dF00d1f916F00DF00D1F916F00df00d0);
    address payee = address(0x1F916beEf1F916bEeF1f916bEEf1F916bEEf1F91);
    address relayer = address(0x1F9164E1A41f9164e1a41f9164E1a41f9164e1a4); // neither funder, payee, verifier, nor registry

    // The real listing shape for the first experiment: $1 per award, 1 award.
    uint256 constant PER = 1_000_000;
    uint32 constant MAX = 1;
    bytes32 listingHash = keccak256("1f916-listing-21-payload-hash");
    uint64 vDeadline;
    uint64 cDeadline;

    /// This suite is meaningless without a Base Sepolia fork, so it says so
    /// and skips rather than passing vacuously on the default chain. A suite
    /// that goes green when its whole premise is absent is worse than a red
    /// one: it reports coverage that does not exist.
    modifier onSepolia() {
        // vm.skip, not an early return. An early return made every one of
        // these report PASSED with the chain absent, which is the vacuous
        // green this modifier exists to prevent.
        vm.skip(block.chainid != 84532);
        _;
    }

    function setUp() public {
        if (block.chainid != 84532) return;
        escrow = new ListingEscrow();
        verifier = vm.addr(verifierKey);
        vDeadline = uint64(block.timestamp + 7 days);
        cDeadline = uint64(block.timestamp + 37 days);
        // REAL USDC, REAL STORAGE LAYOUT. forge's deal() cannot find the
        // balance slot on Circle's FiatTokenProxy, so the balance is written
        // where FiatTokenV2_2 actually keeps it: slot 9, balanceAndBlacklist-
        // States, whose top bit is the blacklist flag and whose low bits are
        // the balance. Writing 10 USDC leaves that flag clear.
        vm.store(address(usdc), keccak256(abi.encode(funder, uint256(9))), bytes32(uint256(10_000_000)));
        // These addresses are unused on Base Sepolia, asserted rather than assumed:
        // 0xBEEF and friends are vanity addresses with real testnet balances,
        // and absolute-balance assertions against them are meaningless.
        assertEq(usdc.balanceOf(payee), 0, "the payee fixture must start empty");
        assertEq(usdc.balanceOf(relayer), 0, "the relayer fixture must start empty");
        assertEq(usdc.balanceOf(funder), 10_000_000, "the fixture must fund the funder or every test below is vacuous");
        // EVERY PRANKED SENDER NEEDS GAS ON A FORK. Without it the call is
        // made with zero gas and reverts with no reason, which cost an hour
        // reading it as a token or contract problem. Cheap to give, and the
        // absence of it looks exactly like a real failure.
        vm.deal(funder, 1 ether);
        vm.deal(relayer, 1 ether);
        vm.deal(payee, 1 ether);
        vm.prank(funder);
        usdc.approve(address(escrow), 10_000_000);
    }

    function _fund(uint32 cap) internal {
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = cap;
        vm.prank(funder);
        escrow.fund(listingHash, address(usdc), PER, MAX, vs, caps, vDeadline, cDeadline);
    }

    function _sig(bytes32 lh, bytes32 awardId, address to, uint64 issuedAt, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Release(bytes32 listingHash,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)"),
            lh, awardId, keccak256("submission-1"), to, keccak256("verdict-payload-hash"), issuedAt
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _release(bytes32 lh, bytes32 awardId, address to, uint64 issuedAt, uint256 key) internal {
        escrow.release(lh, awardId, keccak256("submission-1"), to, keccak256("verdict-payload-hash"), issuedAt, _sig(lh, awardId, to, issuedAt, key));
    }

    /// FUND -> SUBMIT -> VERIFIER PASS -> ANYONE RELAYS -> PAID, with real USDC.
    function test_the_whole_flow_with_real_sepolia_usdc() public onSepolia {
        assertEq(block.chainid, 84532, "this test is meaningless off Base Sepolia");
        _fund(MAX);
        assertEq(usdc.balanceOf(address(escrow)), PER * MAX, "the ceiling is committed at publication");
        assertEq(usdc.balanceOf(funder), 10_000_000 - PER * MAX);

        // The verifier signs. The registry is not in this step at all.
        uint64 issued = uint64(block.timestamp);
        // A relayer who is nobody in particular submits it.
        vm.prank(relayer);
        _release(listingHash, bytes32(uint256(1)), payee, issued);

        assertEq(usdc.balanceOf(payee), PER, "the payee holds exactly the declared amount");
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(relayer), 0, "and the relayer got nothing for relaying");
        (uint32 cap, uint32 used) = escrow.verifierAuthority(listingHash, verifier);
        assertEq(cap, 1);
        assertEq(used, 1);
    }

    function _release(bytes32 lh, bytes32 awardId, address to, uint64 issuedAt) internal {
        _release(lh, awardId, to, issuedAt, verifierKey);
    }

    // ---------------------------------------------------- the negative cases

    function test_a_FAIL_releases_nothing_because_no_signature_is_produced() public onSepolia {
        _fund(MAX);
        // A FAIL is an off-chain fact: the verifier simply does not sign a
        // release. There is no on-chain "fail" to submit, and that is the
        // point. Without a signature the escrow cannot be touched by anyone.
        vm.expectRevert(ListingEscrow.BadSignature.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("v"), uint64(block.timestamp), hex"00");
        assertEq(usdc.balanceOf(address(escrow)), PER * MAX, "a rejected submission moves nothing");
    }

    function test_wrong_payee_is_refused() public onSepolia {
        _fund(MAX);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(listingHash, bytes32(uint256(1)), payee, t, verifierKey);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), address(0xDEAD), keccak256("verdict-payload-hash"), t, sig);
    }

    function test_wrong_listing_hash_is_refused() public onSepolia {
        _fund(MAX);
        uint64 t = uint64(block.timestamp);
        bytes32 other = keccak256("some other listing");
        // The signature is built BEFORE expectRevert: _sig calls
        // escrow.domainSeparator(), and expectRevert would otherwise arm
        // against that staticcall instead of the release.
        bytes memory sig = _sig(other, bytes32(uint256(1)), payee, t, verifierKey);
        vm.expectRevert(ListingEscrow.NotFunded.selector);
        escrow.release(other, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), t, sig);
    }

    function test_a_signature_for_another_contract_is_refused() public onSepolia {
        _fund(MAX);
        // The domain separator names this contract, so a signature produced
        // for a different escrow recovers a different address here.
        ListingEscrow other = new ListingEscrow();
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Release(bytes32 listingHash,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)"),
            listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), uint64(block.timestamp)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, keccak256(abi.encodePacked("\x19\x01", other.domainSeparator(), structHash)));
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), uint64(block.timestamp), abi.encodePacked(r, s, v));
    }

    function test_a_stale_verdict_is_refused() public onSepolia {
        _fund(MAX);
        uint64 stale = vDeadline + 1;
        bytes memory sig = _sig(listingHash, bytes32(uint256(1)), payee, stale, verifierKey);
        vm.expectRevert(ListingEscrow.VerifierWindowClosed.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), stale, sig);
    }

    function test_replaying_a_paid_award_is_refused() public onSepolia {
        _fund(MAX);
        uint64 t = uint64(block.timestamp);
        _release(listingHash, bytes32(uint256(1)), payee, t);
        bytes memory sig = _sig(listingHash, bytes32(uint256(1)), payee, t, verifierKey);
        vm.expectRevert(ListingEscrow.AwardAlreadyPaid.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), t, sig);
    }

    function test_max_awards_exhaustion() public onSepolia {
        _fund(MAX);
        uint64 t = uint64(block.timestamp);
        _release(listingHash, bytes32(uint256(1)), payee, t);
        bytes memory sig = _sig(listingHash, bytes32(uint256(2)), payee, t, verifierKey);
        // The verifier cap and the capacity ceiling both bite here; whichever
        // fires first, no second award is possible on a one-award listing.
        vm.expectRevert();
        escrow.release(listingHash, bytes32(uint256(2)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), t, sig);
        assertEq(usdc.balanceOf(payee), PER);
    }

    function test_refund_before_the_deadline_is_refused_and_after_it_goes_only_to_the_funder() public onSepolia {
        _fund(MAX);
        vm.expectRevert(ListingEscrow.ClaimWindowOpen.selector);
        escrow.refund(listingHash);

        vm.warp(cDeadline + 1);
        uint256 before = usdc.balanceOf(funder);
        vm.prank(relayer);
        escrow.refund(listingHash);
        assertEq(usdc.balanceOf(funder) - before, PER * MAX, "unused money returns to whoever committed it");
        assertEq(usdc.balanceOf(relayer), 0, "and never to whoever called");
    }

    function test_a_verdict_signed_at_the_last_valid_moment_still_gets_the_full_grace() public onSepolia {
        _fund(MAX);
        uint64 t = vDeadline; // the last instant the verifier may decide
        vm.warp(cDeadline);   // the last instant the worker may collect
        _release(listingHash, bytes32(uint256(1)), payee, t);
        assertEq(usdc.balanceOf(payee), PER, "30 days of grace that no verifier delay can consume");
    }

    function test_a_stranger_cannot_authorize_anything() public onSepolia {
        _fund(MAX);
        uint64 t = uint64(block.timestamp);
        bytes memory sig = _sig(listingHash, bytes32(uint256(1)), payee, t, strangerKey);
        vm.expectRevert(ListingEscrow.NotAVerifier.selector);
        escrow.release(listingHash, bytes32(uint256(1)), keccak256("submission-1"), payee, keccak256("verdict-payload-hash"), t, sig);
    }

    /// A MALICIOUS VERIFIER, PUSHED PAST ITS ECONOMIC AUTHORITY. On a listing
    /// with 3 awards and a cap of 1, it gets exactly one and no more, however
    /// many distinct award ids it invents.
    function test_a_malicious_verifier_stops_at_its_declared_cap() public onSepolia {
        bytes32 lh = keccak256("three-award-listing");
        address[] memory vs = new address[](1);
        uint32[] memory caps = new uint32[](1);
        vs[0] = verifier;
        caps[0] = 1;
        vm.prank(funder);
        escrow.fund(lh, address(usdc), PER, 3, vs, caps, vDeadline, cDeadline);

        address attacker = address(0x1F916Bad1f916BAd1f916BAd1f916BaD1f916bAD);
        uint64 t = uint64(block.timestamp);
        _release(lh, bytes32(uint256(1)), attacker, t);
        for (uint256 i = 2; i <= 6; i++) {
            bytes memory sig = _sig(lh, bytes32(i), attacker, t, verifierKey);
            vm.expectRevert(ListingEscrow.VerifierCapExceeded.selector);
            escrow.release(lh, bytes32(i), keccak256("submission-1"), attacker, keccak256("verdict-payload-hash"), t, sig);
        }
        assertEq(usdc.balanceOf(attacker), PER, "one award, the declared cap, and not one more");
        assertEq(usdc.balanceOf(address(escrow)), PER * 2, "the other two awards are still there for honest work");
    }
}
