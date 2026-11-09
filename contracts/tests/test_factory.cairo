//! The launch factory: one call creates the coin, its curve and its payee list, commits the metadata by
//! content, and the creator's dev buy comes first; then the whole life cycle through graduation and fee claims,
//! with every payee's share checked exactly.
use launchpad::fee_vault::FeeVault;
use launchpad::interfaces::{
    CurveParams, IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IFeeVaultDispatcherTrait,
    ILaunchFactoryDispatcherTrait, ILaunchFactorySafeDispatcher, ILaunchFactorySafeDispatcherTrait,
};
use openzeppelin_interfaces::erc20::{
    IERC20Dispatcher, IERC20DispatcherTrait, IERC20MetadataDispatcher, IERC20MetadataDispatcherTrait,
};
use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use crate::common::*;

/// The first 1-currency buy on a fresh curve of this shape, from the reference vectors (step 1).
const FIRST_BUY_OF_ONE: u256 = 34277831558567279767666989;

fn curve_of(launch: launchpad::interfaces::Launch) -> IBondingCurveDispatcher {
    IBondingCurveDispatcher { contract_address: launch.curve }
}

/// What one deposit credits under the vault's rule: protocol share first, then 70/30, remainder to the last.
fn split_70_30(amount: u256, protocol_bps: u256) -> (u256, u256, u256) {
    let protocol = amount * protocol_bps / 10_000;
    let rest = amount - protocol;
    let first = rest * 7_000 / 10_000;
    (protocol, first, rest - first)
}

fn launch_with_metadata(s: @FactorySetup, uri: ByteArray, sha256: u256) -> launchpad::interfaces::Launch {
    let factory = *s.factory;
    start_cheat_caller_address(factory.contract_address, alice());
    let salt: felt252 = factory.launch_count().into();
    let l = factory.launch("Coin", "COIN", uri, sha256, array![payee()], array![10_000], 0, 0, salt, FAR);
    stop_cheat_caller_address(factory.contract_address);
    past_launch_window(s, @l);
    l
}

#[test]
fn launch_creates_the_coin_its_curve_and_its_payee_list() {
    let s = setup_factory(499);
    let l = launch_as(@s, alice(), array![payee(), bob()], array![7_000, 3_000], 0, 0);
    let token = IERC20Dispatcher { contract_address: l.token };
    let meta = IERC20MetadataDispatcher { contract_address: l.token };
    assert_eq!(meta.name(), "Quantum Cat");
    assert_eq!(meta.symbol(), "QCAT");
    assert_eq!(meta.decimals(), 18);
    // The whole supply sits in the curve; the factory keeps nothing.
    let supply = s.factory.supply();
    assert_eq!(token.total_supply(), supply);
    assert_eq!(token.balance_of(l.curve), supply);
    assert_eq!(token.balance_of(s.factory.contract_address), 0);
    // The factory computed the pool reserve (qlp's continuity amount plus 1 ppm + 1).
    let p = s.factory.curve_params();
    assert_eq!(p.x_reserve, 206886218069608574091572237);
    assert_eq!(supply, p.curve_tokens + p.x_reserve);
    assert_eq!(curve_of(l).params(), p);
    assert_eq!(curve_of(l).token(), l.token);
    assert_eq!(curve_of(l).currency(), s.currency.contract_address);
    // The vault states the protocol's share, so the site can show it from the chain.
    assert_eq!(s.vault.protocol_bps(), 499);
    // Payees are registered once, in order.
    assert_eq!(s.vault.payee_count(l.token), 2);
    assert_eq!(s.vault.payee_at(l.token, 0), (payee(), 7_000));
    assert_eq!(s.vault.payee_at(l.token, 1), (bob(), 3_000));
    // The registry, with the metadata committed by content.
    assert_eq!(l.creator, alice());
    assert_eq!(l.dev_tokens, 0);
    assert_eq!(l.metadata_sha256, META_SHA256);
    assert_eq!(s.factory.launch_count(), 1);
    assert_eq!(s.factory.launch_at(0), l);
    assert_eq!(s.factory.launch_of(l.token), l);
    assert_eq!(s.factory.metadata_uri(l.token), meta_uri());
    // Graduation (contract v2): the curve hands its reserve to the factory's locker, which knows the curve.
    assert_eq!(s.factory.curve_of(l.token), l.curve);
    assert_eq!(curve_of(l).state().locker, s.factory.locker());
    assert_eq!(s.factory.curve_of(addr('not a coin')), 0.try_into().unwrap());
}

#[test]
fn the_full_payee_list_is_in_the_events() {
    // Review F3: an indexer can rebuild every coin's payees and shares from events alone.
    let s = setup_factory(0);
    let mut spy = spy_events();
    let l = launch_as(@s, alice(), array![payee(), bob()], array![7_000, 3_000], 0, 0);
    let vault = s.vault.contract_address;
    spy
        .assert_emitted(
            @array![
                (
                    vault,
                    FeeVault::Event::PayeeRegistered(
                        FeeVault::PayeeRegistered {
                            coin: l.token, index: 0, payee: payee(), share_bps: 7_000, count: 2,
                        },
                    ),
                ),
                (
                    vault,
                    FeeVault::Event::PayeeRegistered(
                        FeeVault::PayeeRegistered {
                            coin: l.token, index: 1, payee: bob(), share_bps: 3_000, count: 2,
                        },
                    ),
                ),
            ],
        );
}

// --- Metadata commitment (review F1) ----------------------------------------------------------------------

#[test]
#[should_panic(expected: 'factory: metadata uri')]
fn a_changeable_https_metadata_link_is_refused() {
    let s = setup_factory(0);
    launch_with_metadata(@s, "https://example.com/coin.json", META_SHA256);
}

#[test]
#[should_panic(expected: 'factory: metadata uri')]
fn an_empty_metadata_link_is_refused() {
    let s = setup_factory(0);
    launch_with_metadata(@s, "", META_SHA256);
}

#[test]
#[should_panic(expected: 'factory: metadata uri')]
fn a_malformed_arweave_id_is_refused() {
    let s = setup_factory(0);
    launch_with_metadata(@s, "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_", META_SHA256); // 42 chars
}

#[test]
#[should_panic(expected: 'factory: metadata hash missing')]
fn metadata_without_a_content_hash_is_refused() {
    let s = setup_factory(0);
    launch_with_metadata(@s, meta_uri(), 0);
}

/// The raw CIDv1 of the sample metadata bytes (scripts/metadata_commitment.py ipfs_raw_cid): its digest is
/// META_SHA256.
fn raw_cid_uri() -> ByteArray {
    "ipfs://bafkreihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxum"
}

#[test]
fn a_raw_cid_carrying_the_committed_hash_is_accepted() {
    let s = setup_factory(0);
    let l = launch_with_metadata(@s, raw_cid_uri(), META_SHA256);
    assert_eq!(s.factory.metadata_uri(l.token), raw_cid_uri());
    assert_eq!(s.factory.launch_of(l.token).metadata_sha256, META_SHA256);
}

#[test]
#[should_panic(expected: 'factory: cid != metadata hash')]
fn a_well_formed_cid_of_other_bytes_is_refused() {
    let s = setup_factory(0);
    launch_with_metadata(@s, "ipfs://bafkreifd5lk65wwv36bdddcrnbo3yhaupi3nd74fqt6ifxtlbdil6y5hsu", META_SHA256);
}

#[test]
#[feature("safe_dispatcher")]
fn malformed_content_identifiers_are_refused() {
    // Review V1 (fixes review): the old check accepted any 46-100 alphanumeric characters after ipfs://.
    let s = setup_factory(0);
    let safe = ILaunchFactorySafeDispatcher { contract_address: s.factory.contract_address };
    let bad: Array<ByteArray> = array![
        // V1's case: "b" + 58 "a" decodes to 36 zero bytes, not a CID.
        "ipfs://baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "ipfs://babkreihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxum", // version byte 0
        "ipfs://bafybeihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxum", // dag-pb codec
        "ipfs://bafkrgihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxum", // multihash code 0x13
        "ipfs://bafkreihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxun", // non-zero padding bits
        "ipfs://bafkreihiydibr3sttsw1jbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxum", // '1' is not base32
        "ipfs://BAFKREIHIYDIBR3STTSWWJBL3LCYOM3N7ADAHDNMJHIZ5E3MSICZCY2FXUM", // upper case
        "ipfs://bafkreihiydibr3sttswwjbl3lcyom3n7adahdnmjhiz5e3msiczcy2fxu", // one character short
        "ipfs://QmYwAPJzv5CZsnAzt8auVTLaU2D1wJ1hbH6kPhXj1R4FzV", // CIDv0: not the accepted form
        "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_V", // non-canonical Arweave id (low bits set)
        "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt+U", // '+' is not base64url
    ];
    start_cheat_caller_address(safe.contract_address, alice());
    for uri in bad {
        let result = safe
            .launch("Coin", "COIN", uri, META_SHA256, array![payee()], array![10_000], 0, 0, 0, FAR);
        match result {
            Result::Ok(_) => panic!("accepted a malformed identifier"),
            Result::Err(err) => assert_eq!(reason(err), 'factory: metadata uri'),
        }
    }
    stop_cheat_caller_address(safe.contract_address);
    assert_eq!(s.factory.launch_count(), 0);
}

// --- Dev buy -------------------------------------------------------------------------------------------------

#[test]
fn the_dev_buy_is_first_and_costs_exactly_its_price() {
    let s = setup_factory(0);
    let before = s.currency.balance_of(alice());
    let l = launch_as(@s, alice(), array![payee()], array![10_000], ONE, 0);
    // Same tokens as the reference model's first buy on a fresh curve: nobody could buy ahead of the creator.
    assert_eq!(l.dev_tokens, FIRST_BUY_OF_ONE);
    assert_eq!(IERC20Dispatcher { contract_address: l.token }.balance_of(alice()), FIRST_BUY_OF_ONE);
    assert_eq!(s.currency.balance_of(alice()), before - ONE);
    // Nothing is left behind in the factory, and the factory keeps no allowance on the curve. (The creator's
    // own approval to the factory is theirs to set; the site approves exactly the dev buy.)
    let factory = s.factory.contract_address;
    assert_eq!(s.currency.balance_of(factory), 0);
    assert_eq!(IERC20Dispatcher { contract_address: l.token }.balance_of(factory), 0);
    assert_eq!(s.currency.allowance(factory, l.curve), 0);
    assert_eq!(curve_of(l).state().sold, FIRST_BUY_OF_ONE);
}

#[test]
#[should_panic(expected: 'curve: slippage')]
fn the_dev_buy_respects_its_minimum() {
    let s = setup_factory(0);
    launch_as(@s, alice(), array![payee()], array![10_000], ONE, FIRST_BUY_OF_ONE + 1);
}

// --- The dev buy cap (Hokori 9.99% of the supply) -------------------------------------------------

fn capped_factory() -> FactorySetup {
    let mut params = pump_params();
    params.x_reserve = 0; // the factory computes it
    try_setup_factory_capped(params, 0, 0, 0, 0, mock_core(), 999).unwrap()
}

#[test]
fn the_dev_buy_cap_is_a_share_of_the_supply_and_a_dev_buy_within_it_goes_through() {
    let s = capped_factory();
    let cap = s.factory.max_dev_tokens();
    assert_eq!(cap, s.factory.supply() * 999 / 10_000);
    let l = launch_as(@s, alice(), array![payee()], array![10_000], 3 * ONE, 0); // about 9.7% of the supply
    assert!(l.dev_tokens > 0 && l.dev_tokens <= cap);
}

#[test]
#[should_panic(expected: 'factory: dev buy over cap')]
fn a_dev_buy_over_the_cap_reverts_the_launch() {
    let s = capped_factory();
    launch_as(@s, alice(), array![payee()], array![10_000], 4 * ONE, 0); // about 12.6% of the supply
}

#[test]
#[feature("safe_dispatcher")]
fn a_dev_buy_over_the_cap_leaves_nothing_behind_and_a_cap_over_100_percent_is_refused() {
    let s = capped_factory();
    let safe = ILaunchFactorySafeDispatcher { contract_address: s.factory.contract_address };
    let before = s.currency.balance_of(alice());
    start_cheat_caller_address(s.factory.contract_address, alice());
    let r = safe.launch("Quantum Cat", "QCAT", meta_uri(), META_SHA256, array![payee()], array![10_000], 100 * ONE, 0, 1, FAR);
    stop_cheat_caller_address(s.factory.contract_address);
    match r {
        Result::Ok(_) => panic!("a dev buy that buys out the curve was accepted"),
        Result::Err(err) => assert_eq!(reason(err), 'factory: dev buy over cap'),
    }
    assert_eq!(s.factory.launch_count(), 0);
    assert_eq!(s.currency.balance_of(alice()), before);
    let mut params = pump_params();
    params.x_reserve = 0;
    match try_setup_factory_capped(params, 0, 0, 0, 0, mock_core(), 10_001) {
        Result::Ok(_) => panic!("a cap over 100% was accepted"),
        Result::Err(err) => assert_eq!(reason(err), 'factory: bad dev buy cap'),
    }
}

// --- Life cycle (graduating coins: test_graduation.cairo, on forks) --------------------------------------------------------------------------------------------

#[test]
fn deposits_are_rounded_one_at_a_time() {
    // Review F2's case: two deposits of 11 give the protocol 0 + 0, while splitting 22 at once would give 1.
    let currency = deploy_token("Stark stand-in", "STRK", 1_000 * ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 499);
    let coin = addr('coin');
    vault.register(coin, array![payee(), bob()], array![7_000, 3_000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 11);
    vault.deposit(coin, 11);
    let (p, a, b) = split_70_30(11, 499);
    assert_eq!((p, a, b), (0, 7, 4));
    assert_eq!(vault.balance_of(coin, protocol()), 0);
    assert_eq!(vault.balance_of(coin, payee()), 14);
    assert_eq!(vault.balance_of(coin, bob()), 8);
}

#[test]
fn each_launch_gets_its_own_coin_and_curve() {
    let s = setup_factory(0);
    let a = launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);
    let b = launch_as(@s, bob(), array![bob()], array![10_000], 0, 0);
    assert!(a.token != b.token && a.curve != b.curve);
    assert_eq!(s.factory.launch_count(), 2);
    assert_eq!(s.factory.launch_of(b.token).creator, bob());
    assert_eq!(s.vault.payee_at(b.token, 0), (bob(), 10_000));
}

// --- Refusals ----------------------------------------------------------------------------------------------

#[test]
fn a_factory_with_settings_that_could_not_graduate_is_refused() {
    // Review R2: the factory's own reserve formula gave x_reserve = 1 for this shape, yet graduation would
    // seed zero tokens. The factory now runs the curve's checks when it is deployed.
    let tiny = CurveParams {
        v0: ONE,
        t0: 3,
        curve_tokens: 2,
        x_reserve: 0,
        min_trade: 1,
        fee_bps: 0,
        grad_fee_bps: 0,
        sniper_fee_bps: 0,
        sniper_blocks: 0,
    };
    match try_setup_factory(tiny, 0) {
        Result::Ok(_) => panic!("accepted a factory whose launches could not graduate"),
        Result::Err(err) => assert_eq!(reason(err), 'curve: pool would be empty'),
    }
}

#[test]
#[should_panic(expected: 'vault: shares must sum to 100%')]
fn payee_shares_are_checked_at_launch() {
    let s = setup_factory(0);
    launch_as(@s, alice(), array![payee(), bob()], array![6_000, 3_000], 0, 0);
}

#[test]
#[should_panic(expected: 'factory: bad symbol')]
fn an_empty_ticker_is_refused() {
    let s = setup_factory(0);
    start_cheat_caller_address(s.factory.contract_address, alice());
    s.factory.launch("Quantum Cat", "", meta_uri(), META_SHA256, array![payee()], array![10_000], 0, 0, 0, FAR);
}

#[test]
#[should_panic(expected: 'factory: unknown token')]
fn unknown_tokens_are_not_in_the_registry() {
    let s = setup_factory(0);
    s.factory.launch_of(addr('nobody'));
}

// --- Coin address endings (Hokori: "...dab") ---------------------------------------------------------------------

fn rule_factory(suffix: felt252, digits: u8) -> FactorySetup {
    let mut params = pump_params();
    params.x_reserve = 0;
    try_setup_factory_with_rule(params, 499, suffix, digits).unwrap()
}

fn ends_with(address: starknet::ContractAddress, suffix: u256, digits: u32) -> bool {
    let a: felt252 = address.into();
    let a: u256 = a.into();
    let mut m: u256 = 1;
    for _ in 0..digits {
        m *= 16;
    }
    a % m == suffix
}

/// The first salt from `start` whose address (for `who`, "Quantum Cat"/"QCAT") meets the rule: what the site does.
fn find_salt(s: @FactorySetup, who: starknet::ContractAddress, suffix: u256, digits: u32, start: felt252) -> felt252 {
    let mut salt = start;
    loop {
        if ends_with((*s.factory).token_address_for(who, salt, "Quantum Cat", "QCAT"), suffix, digits) {
            break salt;
        }
        salt += 1;
    }
}

#[test]
fn the_predicted_address_is_where_the_coin_is_deployed() {
    let s = setup_factory(499);
    assert_eq!(s.factory.address_rule(), (0, 0));
    let predicted = s.factory.token_address_for(alice(), 0, "Quantum Cat", "QCAT");
    let l = launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);   // salt 0 (first launch)
    assert_eq!(l.token, predicted);
}

#[test]
fn the_salt_is_bound_to_the_creator() {
    let s = setup_factory(499);
    let a = s.factory.token_address_for(alice(), 7, "Quantum Cat", "QCAT");
    let b = s.factory.token_address_for(bob(), 7, "Quantum Cat", "QCAT");
    assert(a != b, 'same address for two creators');
}

#[test]
fn a_coin_lands_on_the_required_ending() {
    // Two hex digits ("ab") keep the in-test search short (about 256 tries); the rule is the same for "dab".
    let s = rule_factory(0xab, 2);
    assert_eq!(s.factory.address_rule(), (0xab, 2));
    let salt = find_salt(@s, alice(), 0xab, 2, 1000);
    start_cheat_caller_address(s.factory.contract_address, alice());
    let l = s.factory.launch("Quantum Cat", "QCAT", meta_uri(), META_SHA256, array![payee()], array![10_000], 0, 0, salt, FAR);
    stop_cheat_caller_address(s.factory.contract_address);
    assert(ends_with(l.token, 0xab, 2), 'wrong ending');
    assert_eq!(l.token, s.factory.token_address_for(alice(), salt, "Quantum Cat", "QCAT"));
}

#[test]
#[should_panic(expected: 'factory: address suffix')]
fn a_salt_without_the_ending_is_refused() {
    let s = rule_factory(0xab, 2);
    let mut salt: felt252 = 0;
    while ends_with(s.factory.token_address_for(alice(), salt, "Quantum Cat", "QCAT"), 0xab, 2) {
        salt += 1;
    }
    start_cheat_caller_address(s.factory.contract_address, alice());
    s.factory.launch("Quantum Cat", "QCAT", meta_uri(), META_SHA256, array![payee()], array![10_000], 0, 0, salt, FAR);
}

#[test]
fn another_creator_cannot_take_an_address_by_copying_the_salt() {
    let s = rule_factory(0xab, 2);
    let salt = find_salt(@s, alice(), 0xab, 2, 5000);
    // Bob uses Alice's salt: his coin would land elsewhere, almost surely without the ending.
    let bobs = s.factory.token_address_for(bob(), salt, "Quantum Cat", "QCAT");
    assert(bobs != s.factory.token_address_for(alice(), salt, "Quantum Cat", "QCAT"), 'copied salt, same address');
}

#[test]
fn impossible_endings_are_refused_at_creation() {
    let mut params = pump_params();
    params.x_reserve = 0;
    assert!(try_setup_factory_with_rule(params, 499, 0x100, 2).is_err(), "suffix wider than its digits");
    assert!(try_setup_factory_with_rule(params, 499, 0, 17).is_err(), "more than 16 digits");
    assert!(try_setup_factory_with_rule(params, 499, 0xdab, 3).is_ok(), "the Hokori rule is valid");
}

// --- The launch fee (a factory setting, paid to its protocol address; Hokori's launchpads charge none) ------------

const FEE: u256 = 55 * ONE;

fn fee_factory() -> FactorySetup {
    let mut params = pump_params();
    params.x_reserve = 0;
    try_setup_factory_with_fee(params, 499, FEE).unwrap()
}

#[test]
fn a_launch_pays_its_fee_to_the_protocol_and_nothing_else_changes() {
    let s = fee_factory();
    assert_eq!(s.factory.launch_fee(), FEE);
    assert_eq!(s.factory.protocol(), protocol());
    let creator_before = s.currency.balance_of(alice());
    let protocol_before = s.currency.balance_of(protocol());
    let l = launch_as(@s, alice(), array![payee()], array![10_000], ONE, 0);
    assert_eq!(protocol_before + FEE, s.currency.balance_of(protocol()));
    // The creator paid the fee plus exactly the dev buy (first in line, a fresh curve).
    assert_eq!(creator_before - FEE - ONE, s.currency.balance_of(alice()));
    assert_eq!(l.dev_tokens, FIRST_BUY_OF_ONE);
    assert_eq!(s.currency.balance_of(s.factory.contract_address), 0);
}

#[test]
fn the_fee_is_in_the_launch_event() {
    let s = fee_factory();
    let mut spy = spy_events();
    let l = launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);
    let factory = s.factory.contract_address;
    spy.assert_emitted(@array![(factory, launchpad::factory::LaunchFactory::Event::LaunchCreated(launchpad::factory::LaunchFactory::LaunchCreated {
        token: l.token, creator: alice(), curve: l.curve, index: 0, name: "Quantum Cat", symbol: "QCAT", metadata_uri: meta_uri(),
        metadata_sha256: META_SHA256, dev_buy_spent: 0, dev_tokens: 0, launch_fee: FEE,
    }))]);
}

#[test]
#[should_panic]
fn without_an_allowance_for_the_fee_the_launch_fails() {
    let s = fee_factory();
    // Carol approves nothing.
    let carol = starknet::contract_address_const::<'carol-no-allowance'>();
    fund(s.currency, carol, 1_000 * ONE);
    launch_as(@s, carol, array![payee()], array![10_000], 0, 0);
}

#[test]
fn no_fee_means_no_payment() {
    let s = setup_factory(499);
    assert_eq!(s.factory.launch_fee(), 0);
    let before = s.currency.balance_of(protocol());
    launch_as(@s, alice(), array![payee()], array![10_000], 0, 0);
    assert_eq!(s.currency.balance_of(protocol()), before);
}
