//! User-triggered distributions: exact amounts, arbitrary callers, old claims, and atomic failure.
use launchpad::fee_distribution::{
    IFeeDistributionDispatcher, IFeeDistributionDispatcherTrait,
    IFeeDistributionSafeDispatcher, IFeeDistributionSafeDispatcherTrait,
};
use launchpad::interfaces::{IFeeVaultDispatcherTrait, IBondingCurveDispatcherTrait};
use openzeppelin_interfaces::erc20::IERC20DispatcherTrait;
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address, spy_events, EventSpyAssertionsTrait};
use crate::common::*;

#[test]
fn distribute_anyone_pays_registered_recipients_and_preserves_protocol_and_other_coins() {
    let currency = deploy_token("Currency", "STRK", 10_000, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 1500);
    let coin = addr('coin');
    vault.register(coin, array![alice(), bob()], array![7000, 3000]);
    vault.register(addr('other'), array![alice()], array![10000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 1000);
    vault.deposit(addr('other'), 1000);
    let payout = IFeeDistributionDispatcher { contract_address: vault.contract_address };
    let mut spy = spy_events();
    start_cheat_caller_address(vault.contract_address, carol());
    assert_eq!(payout.distribute(coin), 850);
    assert_eq!(payout.distribute(coin), 0);
    stop_cheat_caller_address(vault.contract_address);
    assert_eq!(currency.balance_of(alice()), 595);
    assert_eq!(currency.balance_of(bob()), 255);
    assert_eq!(currency.balance_of(carol()), 0);
    assert_eq!(vault.balance_of(coin, alice()), 0);
    assert_eq!(vault.balance_of(coin, bob()), 0);
    assert_eq!(vault.balance_of(coin, protocol()), 150);
    assert_eq!(vault.balance_of(addr('other'), alice()), 850);
    spy.assert_emitted(@array![(vault.contract_address, launchpad::fee_vault::FeeVault::Event::Claimed(
        launchpad::fee_vault::FeeVault::Claimed { coin, account: alice(), amount: 595 }
    )), (vault.contract_address, launchpad::fee_vault::FeeVault::Event::Claimed(
        launchpad::fee_vault::FeeVault::Claimed { coin, account: bob(), amount: 255 }
    ))]);
    start_cheat_caller_address(vault.contract_address, protocol());
    assert_eq!(vault.claim(coin), 150);
    stop_cheat_caller_address(vault.contract_address);
    assert_eq!(currency.balance_of(protocol()), 150);
}

#[test]
fn distribute_after_manual_claim_and_again_after_new_deposit() {
    let currency = deploy_token("Currency", "STRK", 10_000, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    let coin = addr('coin');
    vault.register(coin, array![alice(), bob()], array![5000, 5000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 1000);
    start_cheat_caller_address(vault.contract_address, alice());
    assert_eq!(vault.claim(coin), 500);
    let payout = IFeeDistributionDispatcher { contract_address: vault.contract_address };
    assert_eq!(payout.distribute(coin), 500);
    assert_eq!(vault.claim(coin), 0);
    stop_cheat_caller_address(vault.contract_address);
    vault.deposit(coin, 200);
    assert_eq!(payout.distribute(coin), 200);
    assert_eq!(currency.balance_of(alice()), 600);
    assert_eq!(currency.balance_of(bob()), 600);
}

#[test]
fn distribute_duplicates_and_protocol_payee_are_not_double_paid_or_drained() {
    let currency = deploy_token("Currency", "STRK", 10_000, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 1500);
    let coin = addr('coin');
    vault.register(coin, array![alice(), alice(), protocol()], array![2000, 3000, 5000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 1000);
    let payout = IFeeDistributionDispatcher { contract_address: vault.contract_address };
    assert_eq!(payout.distribute(coin), 425);
    assert_eq!(currency.balance_of(alice()), 425);
    assert_eq!(currency.balance_of(protocol()), 0);
    assert_eq!(vault.balance_of(coin, protocol()), 575);
    start_cheat_caller_address(vault.contract_address, protocol());
    assert_eq!(vault.claim(coin), 575);
    stop_cheat_caller_address(vault.contract_address);
}

#[test]
fn distribute_ten_payees_and_rounding_dust() {
    let currency = deploy_token("Currency", "STRK", 10_000, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    let coin = addr('coin');
    let mut payees = array![];
    let mut shares = array![];
    for i in 1_u32..11_u32 { payees.append(addr(i.into())); shares.append(1000); }
    vault.register(coin, payees, shares);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    let payout = IFeeDistributionDispatcher { contract_address: vault.contract_address };
    assert_eq!(payout.distribute(coin), 0);
    vault.deposit(coin, 1001);
    assert_eq!(payout.distribute(coin), 1001);
    for i in 1_u32..10_u32 { assert_eq!(currency.balance_of(addr(i.into())), 100); }
    assert_eq!(currency.balance_of(addr(10)), 101);
    vault.deposit(coin, 1);
    assert_eq!(payout.distribute(coin), 1);
    assert_eq!(currency.balance_of(addr(10)), 102);
}

#[test]
#[feature("safe_dispatcher")]
fn distribute_failed_later_transfer_rolls_back_earlier_payment_and_all_credits() {
    let currency = deploy_token("Currency", "STRK", 1000, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    let coin = addr('coin');
    vault.register(coin, array![alice(), bob()], array![5000, 5000]);
    approve_as(currency, starknet::get_contract_address(), vault.contract_address);
    vault.deposit(coin, 1000);
    // Fault injection: make the token transfer to the second recipient fail after the first succeeded.
    transfer_as(currency, vault.contract_address, carol(), 400);
    let payout = IFeeDistributionSafeDispatcher { contract_address: vault.contract_address };
    assert!(payout.distribute(coin).is_err());
    assert_eq!(currency.balance_of(alice()), 0);
    assert_eq!(currency.balance_of(bob()), 0);
    assert_eq!(vault.balance_of(coin, alice()), 500);
    assert_eq!(vault.balance_of(coin, bob()), 500);
    assert_eq!(currency.balance_of(vault.contract_address), 600);
    transfer_as(currency, carol(), vault.contract_address, 400);
    assert_eq!(payout.distribute(coin).unwrap(), 1000);
}

#[test]
#[should_panic(expected: 'vault: unknown coin')]
fn distribute_unknown_coin_is_refused() {
    let currency = deploy_token("Currency", "STRK", ONE, starknet::get_contract_address());
    let vault = deploy_vault(currency.contract_address, 0);
    IFeeDistributionDispatcher { contract_address: vault.contract_address }.distribute(addr('unknown'));
}

#[test]
fn distribute_includes_flushed_curve_fees() {
    let s = setup_curve(pump_params());
    buy_as(@s, alice(), 10 * ONE);
    let fees = s.curve.state().fees;
    assert!(fees > 0);
    s.curve.flush_fees();
    assert_eq!(IFeeDistributionDispatcher { contract_address: s.vault.contract_address }.distribute(s.token.contract_address), fees);
    assert_eq!(s.currency.balance_of(payee()), fees);
}
