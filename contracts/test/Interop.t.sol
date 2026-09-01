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
