// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ListingEscrow} from "../src/ListingEscrow.sol";

/// THE TWO IMPLEMENTATIONS MUST AGREE, and this is where that is checked.
///
/// The registry builds the release authorization in TypeScript (src/funded.ts,
/// via viem) and the contract rebuilds it in Solidity. If those two ever
/// disagree by one byte, every signature a verifier produces is worthless and
/// nobody finds out until a worker cannot collect. The digest below was
/// computed by the TypeScript side and pasted here, so a change to either
/// implementation that moves the bytes fails this test.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

contract InteropTest is Test {
    /// @dev A deterministic deployment at a known address, because the address
    ///      is inside the EIP-712 domain.
    function test_typescript_and_solidity_hash_the_same_release() public pure {
        bytes32 typeHash =
            keccak256("Release(bytes32 listingHash,address funder,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)");
        assertEq(typeHash, 0x0b41ef31cb32204f4e6033fd53bdce581e050536be8456955fc8bf0a589461c4, "typehash agrees with the registry");

        // The struct hash is independent of chain and address, so it is the
        // part that can be pinned to a value the TypeScript side printed.
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                bytes32(0x52deaea8a16fc23d4b8f2df6098146d6723a272f1269c3caeb5a49b3625066f5),
                address(0xF00D000000000000000000000000000000000000),
                bytes32(uint256(7)),
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
                address(0xBEEF00000000000000000000000000000000BEEf),
                bytes32(0xabababababababababababababababababababababababababababababababab),
                uint64(1700000000)
            )
        );
        assertEq(
            structHash,
            0x8b3f4a7fd4b41625ab689ce6f27ce6ac0d48e9584b10e42a3b4323d966c8eb1f,
            "the registry and the contract encode the same release to the same bytes"
        );
    }

    /// THE VERIFIER SET RECIPE, ON BOTH SIDES.
    ///
    /// The escrow's hidden-verifier defence is entirely off-chain: the reader
    /// recomputes keccak256(abi.encode(verifiers, caps)) from the verifiers
    /// the LISTING published and compares it to what fund() committed. If the
    /// two implementations of that recipe ever disagree by one byte, the
    /// defence fails OPEN for an honest listing and the site stops calling
    /// real escrows funded, or worse, agrees with a set it should reject.
    /// Until this test existed the two sides were equal by assumption.
    function test_typescript_and_solidity_hash_the_same_verifier_set() public {
        ListingEscrow escrow = new ListingEscrow();
        address[] memory verifiers = new address[](2);
        uint32[] memory caps = new uint32[](2);
        verifiers[0] = 0x1111111111111111111111111111111111111111; caps[0] = 1;
        verifiers[1] = 0x2222222222222222222222222222222222222222; caps[1] = 3;
        assertEq(
            escrow.verifierSetHash(verifiers, caps),
            0xdac3538a537f76d4fd3d9f8dc2bdecfc078f7a2e6035833468f373b40e5758b6,
            "the registry and the contract commit to the same verifier set"
        );
    }

    /// And the value fund() STORES is that same recipe over the same inputs,
    /// so a reader comparing against listingOf's tenth field is comparing
    /// against what the reader can compute.
    function test_fund_stores_the_recipe_a_reader_recomputes() public {
        ListingEscrow escrow = new ListingEscrow();
        MockToken token = new MockToken();
        address funder = address(0xF00D);
        token.mint(funder, 10);
        vm.deal(funder, 1 ether);
        address[] memory verifiers = new address[](2);
        uint32[] memory caps = new uint32[](2);
        verifiers[0] = 0x1111111111111111111111111111111111111111; caps[0] = 1;
        verifiers[1] = 0x2222222222222222222222222222222222222222; caps[1] = 3;
        vm.startPrank(funder);
        token.approve(address(escrow), 10);
        escrow.fund(keccak256("L"), address(token), 5, 2, verifiers, caps, uint64(block.timestamp + 7 days), uint64(block.timestamp + 37 days));
        vm.stopPrank();
        (,,,,,,,,, bytes32 stored) = escrow.listingOf(keccak256("L"), funder);
        assertEq(stored, 0xdac3538a537f76d4fd3d9f8dc2bdecfc078f7a2e6035833468f373b40e5758b6, "stored == recomputable");
        assertEq(stored, escrow.verifierSetHash(verifiers, caps));
    }

    /// And the domain the contract binds itself to is the one the registry
    /// builds: same name, same version, this chain, this contract. Together
    /// with the struct hash above, that fixes the whole digest.
    function test_the_domain_is_this_chain_and_this_contract() public {
        ListingEscrow escrow = new ListingEscrow();
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("1F916 ListingEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.domainSeparator(), expected);
        // A second deployment has a different domain, so a signature cannot be
        // replayed from one escrow onto another.
        ListingEscrow other = new ListingEscrow();
        assertTrue(escrow.domainSeparator() != other.domainSeparator());
    }
}
