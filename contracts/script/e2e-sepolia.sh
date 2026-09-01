#!/usr/bin/env bash
# FUND -> VERIFIER SIGNS -> ANYONE RELAYS -> PAID, as real transactions.
#
# This is a runbook, not a test. forge's cheatcodes could be hiding something,
# so the flow is also proven outside the harness: cast sends an actual approve,
# fund and release. Point RPC at an anvil fork of Base Sepolia
# (anvil --fork-url https://sepolia.base.org) or, with funded keys, at Base
# Sepolia itself.
#
# The keys below are anvil's published test keys. They are famous, public and
# hold nothing. NEVER put a key with real value in this file.
#
# Measured on a Base Sepolia fork against Circle's real testnet USDC:
#   fund     185,542 gas
#   release  134,014 gas, relayed by an address that is not the funder, not
#            the payee and not the verifier.
set -e
export PATH="$PATH:/Users/dovi/.foundry/bin"
RPC=http://127.0.0.1:8545
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
FUNDER=$(cast wallet address $FUNDER_KEY)
VERIFIER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
VERIFIER=$(cast wallet address $VERIFIER_KEY)
RELAYER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
PAYEE=0x1F916beEf1F916bEeF1f916bEEf1F916bEEf1F91
ESCROW=$(forge create src/ListingEscrow.sol:ListingEscrow --rpc-url $RPC --private-key $FUNDER_KEY --broadcast --json | python3 -c "import sys,json;print(json.load(sys.stdin)['deployedTo'])")
echo "ESCROW=$ESCROW"
# give the funder real USDC on the fork, at FiatTokenV2_2's balance slot
SLOT=$(cast index address $FUNDER 9)
cast rpc anvil_setStorageAt $USDC $SLOT 0x00000000000000000000000000000000000000000000000000000000000f4240 --rpc-url $RPC >/dev/null
echo "funder USDC: $(cast call $USDC 'balanceOf(address)(uint256)' $FUNDER --rpc-url $RPC)"
LH=0x$(python3 -c "import hashlib;print(hashlib.sha256(b'1f916-listing-sepolia-e2e-run3').hexdigest())")
echo "LISTING_HASH=$LH"
NOW=$(cast block latest --rpc-url $RPC --field timestamp)
VD=$((NOW + 604800)); CD=$((NOW + 3196800))
cast send $USDC "approve(address,uint256)" $ESCROW 1000000 --private-key $FUNDER_KEY --rpc-url $RPC --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('approve tx',d['transactionHash'],'status',d['status'])"
cast send $ESCROW "fund(bytes32,address,uint256,uint32,address[],uint32[],uint64,uint64)" $LH $USDC 1000000 1 "[$VERIFIER]" "[1]" $VD $CD --private-key $FUNDER_KEY --rpc-url $RPC --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('FUND tx',d['transactionHash'],'status',d['status'],'gas',int(d['gasUsed'],16))"
echo "escrow USDC after fund: $(cast call $USDC 'balanceOf(address)(uint256)' $ESCROW --rpc-url $RPC)"
DS=$(cast call $ESCROW "domainSeparator()(bytes32)" --rpc-url $RPC)
TH=$(cast keccak "Release(bytes32 listingHash,bytes32 awardId,bytes32 submissionHash,address payee,bytes32 verdictHash,uint64 issuedAt)")
AWARD=0x0000000000000000000000000000000000000000000000000000000000000001
SUB=$(cast keccak "submission-1"); VH=$(cast keccak "verdict-payload-hash")
STRUCT=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,bytes32,address,bytes32,uint64)" $TH $LH $AWARD $SUB $PAYEE $VH $NOW))
DIGEST=$(cast keccak $(cast concat-hex 0x1901 $DS $STRUCT))
SIG=$(cast wallet sign --no-hash --private-key $VERIFIER_KEY $DIGEST)
echo "VERIFIER=$VERIFIER"
echo "verifier signature: $SIG"
cast send $ESCROW "release(bytes32,address,bytes32,bytes32,address,bytes32,uint64,bytes)" $LH $FUNDER $AWARD $SUB $PAYEE $VH $NOW $SIG --private-key $RELAYER_KEY --rpc-url $RPC --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('RELEASE tx',d['transactionHash'],'status',d['status'],'gas',int(d['gasUsed'],16),'relayed by a third party')"
echo "payee USDC: $(cast call $USDC 'balanceOf(address)(uint256)' $PAYEE --rpc-url $RPC)"
echo "escrow USDC: $(cast call $USDC 'balanceOf(address)(uint256)' $ESCROW --rpc-url $RPC)"
cast call $ESCROW "verifierAuthority(bytes32,address,address)(uint32,uint32)" $LH $FUNDER $VERIFIER --rpc-url $RPC | tr '\n' ' ' | sed 's/^/verifier cap,used: /'
echo
