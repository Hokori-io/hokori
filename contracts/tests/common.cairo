//! Test helpers: deploy a currency (a stand-in for STRK), the fee vault, a coin with its curve (graduating into
//! a stand-in locker), or a factory (against a stand-in Ekubo Core, or the real one on a fork), and trade as a
//! named account.
use launchpad::interfaces::{
    CurveBuy, CurveParams, CurveSell, IBondingCurveDispatcher, IBondingCurveDispatcherTrait,
    IBondingCurveSafeDispatcher, IBondingCurveSafeDispatcherTrait, IFeeVaultDispatcher,
    IFeeVaultDispatcherTrait, ILaunchFactoryDispatcher, ILaunchFactoryDispatcherTrait, Launch,
};
use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_number_global,
    start_cheat_caller_address, stop_cheat_caller_address, test_address,
};
use starknet::{ClassHash, ContractAddress};

pub const ONE: u256 = 1_000_000_000_000_000_000;
/// A content-addressed metadata link and the SHA-256 of its (sample) bytes, as a launch commits them.
pub fn meta_uri() -> ByteArray {
    "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U"
}
pub const META_SHA256: u256 =
    105277251743132825750193647753306226788153409733863833658839041147591176271779;
pub const FAR: u64 = 0xffffffffffffffff;
pub const MAX: u256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
/// The block every test curve and factory is created in.
pub const LAUNCH_BLOCK: u64 = 1_000;

pub fn addr(name: felt252) -> ContractAddress {
    name.try_into().unwrap()
}
pub fn alice() -> ContractAddress {
    addr('alice')
}
pub fn bob() -> ContractAddress {
    addr('bob')
}
pub fn carol() -> ContractAddress {
    addr('carol')
}
pub fn payee() -> ContractAddress {
    addr('payee')
}
pub fn protocol() -> ContractAddress {
    addr('protocol')
}
pub fn traders() -> Array<ContractAddress> {
    array![alice(), bob(), carol()]
}

/// A pump.fun-shaped curve: 30 virtual currency, 1.073B virtual tokens, 793.1M sold on the curve, 1% fee, and
/// Hokori's launch window (99% on buys in the launch block and the next).
pub fn pump_params() -> CurveParams {
    CurveParams {
        v0: 30 * ONE,
        t0: 1_073_000_000 * ONE,
        curve_tokens: 793_100_000 * ONE,
        x_reserve: 206_886_218_069_608_574_091_572_236,
        min_trade: 1_000_000_000_000,
        fee_bps: 100,
        grad_fee_bps: 100,
        sniper_fee_bps: 9900,
        sniper_blocks: 2,
    }
}

pub fn deploy_token(
    name: ByteArray, symbol: ByteArray, supply: u256, recipient: ContractAddress,
) -> IERC20Dispatcher {
    let class = declare("LaunchToken").unwrap().contract_class();
    let mut calldata = array![];
    name.serialize(ref calldata);
    symbol.serialize(ref calldata);
    supply.serialize(ref calldata);
    recipient.serialize(ref calldata);
    let (address, _) = class.deploy(@calldata).unwrap();
    IERC20Dispatcher { contract_address: address }
}

pub fn class_of(name: ByteArray) -> ClassHash {
    *declare(name).unwrap().contract_class().class_hash
}

pub fn deploy_vault(currency: ContractAddress, protocol_bps: u16) -> IFeeVaultDispatcher {
    let class = declare("FeeVault").unwrap().contract_class();
    let mut calldata = array![];
    test_address().serialize(ref calldata); // the registrar
    currency.serialize(ref calldata);
    protocol().serialize(ref calldata);
    protocol_bps.serialize(ref calldata);
    let (address, _) = class.deploy(@calldata).unwrap();
    IFeeVaultDispatcher { contract_address: address }
}

/// Sends `amount` of `token` from the test contract (which holds every minted supply) to `to`.
pub fn fund(token: IERC20Dispatcher, to: ContractAddress, amount: u256) {
    assert!(token.transfer(to, amount));
}

pub fn approve_as(token: IERC20Dispatcher, owner: ContractAddress, spender: ContractAddress) {
    start_cheat_caller_address(token.contract_address, owner);
    assert!(token.approve(spender, MAX));
    stop_cheat_caller_address(token.contract_address);
}

pub fn transfer_as(token: IERC20Dispatcher, from: ContractAddress, to: ContractAddress, amount: u256) {
    start_cheat_caller_address(token.contract_address, from);
    assert!(token.transfer(to, amount));
    stop_cheat_caller_address(token.contract_address);
}

/// The first felt of a revert's panic data: the error message.
pub fn reason(err: Array<felt252>) -> felt252 {
    *err.at(0)
}

#[derive(Copy, Drop)]
pub struct CurveSetup {
    pub curve: IBondingCurveDispatcher,
    pub token: IERC20Dispatcher,
    pub currency: IERC20Dispatcher,
    pub vault: IFeeVaultDispatcher,
    pub locker: ContractAddress, // a stand-in that keeps what graduation sends it
}

/// A stand-in for Ekubo Core that only accepts the locker's registration (for factories that never graduate).
pub fn mock_core() -> ContractAddress {
    let (address, _) = declare("MockEkuboCore").unwrap().contract_class().deploy(@array![]).unwrap();
    address
}

/// A coin and its curve as the factory creates them: supply = curve tokens + pool reserve, all held by the
/// curve (unless `fund_curve` is false); one payee taking the whole payees' part; the traders funded with
/// `trader_funds` of currency each and approvals. Returns the constructor's revert data if it refuses.
pub fn try_setup_curve(
    params: CurveParams, fund_curve: bool, trader_funds: u256,
) -> Result<CurveSetup, Array<felt252>> {
    let currency = deploy_token("Stark stand-in", "STRK", MAX / 2, test_address());
    let vault = deploy_vault(currency.contract_address, 0);
    let supply = params.curve_tokens + params.x_reserve;
    let token = deploy_token("Coin", "COIN", supply, test_address());
    let class = declare("BondingCurve").unwrap().contract_class();
    let (locker, _) = declare("MockGradLocker").unwrap().contract_class().deploy(@array![]).unwrap();
    start_cheat_block_number_global(LAUNCH_BLOCK);
    let mut calldata = array![];
    token.contract_address.serialize(ref calldata);
    currency.contract_address.serialize(ref calldata);
    vault.contract_address.serialize(ref calldata);
    locker.serialize(ref calldata);
    params.serialize(ref calldata);
    let address = match class.deploy(@calldata) {
        Result::Ok((address, _)) => address,
        Result::Err(err) => { return Result::Err(err); },
    };
    let curve = IBondingCurveDispatcher { contract_address: address };
    if fund_curve {
        fund(token, address, supply);
    }
    vault.register(token.contract_address, array![payee()], array![10_000]);
    for who in traders() {
        fund(currency, who, trader_funds);
        approve_as(currency, who, address);
        approve_as(token, who, address);
    }
    // Trading starts after the launch window (tests of the window move the block back).
    start_cheat_block_number_global(LAUNCH_BLOCK + params.sniper_blocks);
    Result::Ok(CurveSetup { curve, token, currency, vault, locker })
}

pub fn setup_curve(params: CurveParams) -> CurveSetup {
    try_setup_curve(params, true, 1_000_000 * ONE).unwrap()
}

pub fn buy_as(s: @CurveSetup, who: ContractAddress, gross: u256) -> CurveBuy {
    let curve = *s.curve;
    start_cheat_caller_address(curve.contract_address, who);
    let r = curve.buy(gross, 0, FAR);
    stop_cheat_caller_address(curve.contract_address);
    r
}

/// A buy that also graduates the coin if it takes the curve's last tokens.
pub fn buy_and_graduate_as(s: @CurveSetup, who: ContractAddress, gross: u256) -> CurveBuy {
    let curve = *s.curve;
    start_cheat_caller_address(curve.contract_address, who);
    let r = curve.buy_and_graduate(gross, 0, FAR);
    stop_cheat_caller_address(curve.contract_address);
    r
}

pub fn sell_as(s: @CurveSetup, who: ContractAddress, tokens: u256) -> CurveSell {
    let curve = *s.curve;
    start_cheat_caller_address(curve.contract_address, who);
    let r = curve.sell(tokens, 0, FAR);
    stop_cheat_caller_address(curve.contract_address);
    r
}

/// Sells `who`'s whole holding if the curve will take it. The only acceptable refusal is a holding worth
/// nothing after its fee; anything else fails the test. Returns whether it sold.
#[feature("safe_dispatcher")]
pub fn try_sell_all(s: @CurveSetup, who: ContractAddress) -> bool {
    let held = (*s.token).balance_of(who);
    if held == 0 {
        return false;
    }
    let safe = IBondingCurveSafeDispatcher { contract_address: (*s.curve).contract_address };
    start_cheat_caller_address(safe.contract_address, who);
    let result = safe.sell(held, 0, FAR);
    stop_cheat_caller_address(safe.contract_address);
    match result {
        Result::Ok(_) => true,
        Result::Err(err) => {
            assert_eq!(reason(err), 'curve: sell pays nothing');
            false
        },
    }
}

/// The curve's balances equal its books: currency == real + fees; tokens == unsold + pool reserve (until it
/// graduates); and the curve invariants hold.
pub fn check_curve_balances(s: @CurveSetup) {
    let st = (*s.curve).state();
    let p = (*s.curve).params();
    let me = (*s.curve).contract_address;
    assert_eq!((*s.currency).balance_of(me), st.real + st.fees);
    if !st.graduated {
        assert_eq!((*s.token).balance_of(me), p.curve_tokens - st.sold + p.x_reserve);
        assert_eq!(st.t, p.t0 - st.sold);
        assert!(st.q * st.t >= p.v0 * p.t0);
        assert_eq!(st.real, st.q - p.v0);
    }
}

#[derive(Copy, Drop)]
pub struct FactorySetup {
    pub factory: ILaunchFactoryDispatcher,
    pub currency: IERC20Dispatcher,
    pub vault: IFeeVaultDispatcher,
}

/// A factory with the given curve shape (it computes the pool reserve itself), the protocol taking
/// `protocol_bps` of every fee deposit, and the traders funded with currency and approvals for the factory.
pub fn try_setup_factory(
    params: CurveParams, protocol_bps: u16,
) -> Result<FactorySetup, Array<felt252>> {
    try_setup_factory_with_rule(params, protocol_bps, 0, 0)
}

/// A factory charging `fee` currency per launch (no address rule).
pub fn try_setup_factory_with_fee(params: CurveParams, protocol_bps: u16, fee: u256) -> Result<FactorySetup, Array<felt252>> {
    try_setup_factory_full(params, protocol_bps, 0, 0, fee, mock_core())
}

/// A factory that requires coin addresses to end in the hex digits `suffix` (`digits` of them; 0: no rule).
pub fn try_setup_factory_with_rule(
    params: CurveParams, protocol_bps: u16, suffix: felt252, digits: u8,
) -> Result<FactorySetup, Array<felt252>> {
    try_setup_factory_full(params, protocol_bps, suffix, digits, 0, mock_core())
}

/// A factory whose coins graduate into Ekubo Core at `core` (the real one, in a fork test).
pub fn setup_factory_on(core: ContractAddress, protocol_bps: u16) -> FactorySetup {
    let mut params = pump_params();
    params.x_reserve = 0; // the factory computes it
    try_setup_factory_full(params, protocol_bps, 0, 0, 0, core).unwrap()
}

pub fn try_setup_factory_full(
    params: CurveParams, protocol_bps: u16, suffix: felt252, digits: u8, fee: u256, core: ContractAddress,
) -> Result<FactorySetup, Array<felt252>> {
    try_setup_factory_capped(params, protocol_bps, suffix, digits, fee, core, 10_000)
}

/// As try_setup_factory_full, with a dev buy cap of `max_dev_bps` of the supply (10,000: none; Hokori: 999).
pub fn try_setup_factory_capped(
    params: CurveParams, protocol_bps: u16, suffix: felt252, digits: u8, fee: u256, core: ContractAddress, max_dev_bps: u16,
) -> Result<FactorySetup, Array<felt252>> {
    let currency = deploy_token("Stark stand-in", "STRK", 1_000_000_000 * ONE, test_address());
    try_setup_factory_as(params, protocol_bps, suffix, digits, fee, core, max_dev_bps, protocol(), currency)
}

/// As try_setup_factory_capped, for a given protocol address (the splitter, in the staking tests) and an already
/// deployed currency whose supply the test account holds.
pub fn try_setup_factory_as(
    params: CurveParams,
    protocol_bps: u16,
    suffix: felt252,
    digits: u8,
    fee: u256,
    core: ContractAddress,
    max_dev_bps: u16,
    protocol_address: ContractAddress,
    currency: IERC20Dispatcher,
) -> Result<FactorySetup, Array<felt252>> {
    let class = declare("LaunchFactory").unwrap().contract_class();
    start_cheat_block_number_global(LAUNCH_BLOCK);
    let mut calldata = array![];
    currency.contract_address.serialize(ref calldata);
    class_of("LaunchToken").serialize(ref calldata);
    class_of("BondingCurve").serialize(ref calldata);
    class_of("FeeVault").serialize(ref calldata);
    class_of("GradLocker").serialize(ref calldata);
    core.serialize(ref calldata);
    protocol_address.serialize(ref calldata);
    protocol_bps.serialize(ref calldata);
    params.serialize(ref calldata);
    suffix.serialize(ref calldata);
    digits.serialize(ref calldata);
    fee.serialize(ref calldata);
    max_dev_bps.serialize(ref calldata);
    let address = match class.deploy(@calldata) {
        Result::Ok((address, _)) => address,
        Result::Err(err) => { return Result::Err(err); },
    };
    let factory = ILaunchFactoryDispatcher { contract_address: address };
    let vault = IFeeVaultDispatcher { contract_address: factory.fee_vault() };
    for who in traders() {
        fund(currency, who, 1_000_000 * ONE);
        approve_as(currency, who, address);
    }
    Result::Ok(FactorySetup { factory, currency, vault })
}

pub fn setup_factory(protocol_bps: u16) -> FactorySetup {
    let mut params = pump_params();
    params.x_reserve = 0; // the factory computes it
    try_setup_factory(params, protocol_bps).unwrap()
}

pub fn launch_as(
    s: @FactorySetup,
    who: ContractAddress,
    payees: Array<ContractAddress>,
    shares: Array<u16>,
    dev_buy: u256,
    min_dev_tokens: u256,
) -> Launch {
    let factory = *s.factory;
    // A fresh salt per launch (the same creator, name and salt would give the same address twice).
    let salt: felt252 = factory.launch_count().into();
    start_cheat_caller_address(factory.contract_address, who);
    let launch = factory
        .launch(
            "Quantum Cat",
            "QCAT",
            meta_uri(),
            META_SHA256,
            payees,
            shares,
            dev_buy,
            min_dev_tokens,
            salt,
            FAR,
        );
    stop_cheat_caller_address(factory.contract_address);
    past_launch_window(s, @launch);
    launch
}

/// Moves every contract's block number past `launch`'s window, so later trades pay the normal fee.
pub fn past_launch_window(s: @FactorySetup, launch: @Launch) {
    let curve = IBondingCurveDispatcher { contract_address: *launch.curve };
    start_cheat_block_number_global(curve.launch_block() + (*s.factory).curve_params().sniper_blocks);
}
