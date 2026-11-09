/// Launch option A: a bonding curve with virtual reserves, then a permanent pool (PROTOCOL-SPEC §3).
///
/// Pricing is the constant product on virtual reserves (q, t) with k = v0 * t0. The curve starts with no real
/// currency: v0 only shapes the price. Invariants, after every trade:
///   t == t0 - sold;  q * t >= k;  real == q - v0 >= 0
/// and selling every outstanding curve token pays out exactly `real` before fees (the payouts telescope to
/// q - ceil(k / t0) = q - v0). Sells are capped at `sold`, so tokens that never came from the curve can't push
/// t above t0, which is what keeps `real` non-negative.
///
/// Sells are refused only when they would pay the seller nothing after the fee; the minimum trade applies to
/// buys. So any holding worth at least two base units of currency can be sold back, however it was split.
///
/// Graduation (contract v2): the curve always closes at the same state (see `math::graduation_seed`), so the
/// constructor checks that graduation will seed a non-empty pool within the reserved tokens. The buy that takes
/// the last curve token closes the curve. Graduation then sends the real reserve (minus the graduation fee) and
/// X = floor(Y * t / q) tokens to the factory's Ekubo locker, which opens the coin's Ekubo pool at the curve's final
/// price (never below it) with that liquidity locked forever; spare reserve tokens are burned.
///
/// Graduating costs about three times the gas of a buy, and a wallet caps a transaction's gas near its own
/// estimate. So a buy graduates only when its caller asks (review d2684e0 R3), and only as the last
/// buy: `buy_and_graduate` must take the curve's last tokens, or it reverts ("curve: not the last buy"); it then
/// graduates in the same call (all or nothing). So it can never be estimated as a cheap buy and execute the
/// graduation (review b37a86c R1): an estimate made when it wouldn't close the curve fails. A plain `buy` never
/// graduates: one that ends up taking the last tokens, because others bought first, still succeeds within its own
/// gas and just closes the curve. Hokori's graduation service then calls the public `graduate` within seconds, at
/// Hokori's cost, and anyone else may too. While closed and not yet graduated, the curve takes no trades.
///
/// Launch window: buys in the launch block and the next `sniper_blocks - 1` pay `sniper_fee_bps` (Hokori: 99% for
/// two blocks) instead of the normal fee, so bots that buy the instant a coin appears pay nearly everything to the
/// fee vault. The creator's dev buy, made by the factory inside the launch itself, pays the normal fee. The extra fee
/// is an ordinary fee: it goes where every fee goes, and changes nothing about how the curve closes.
#[starknet::contract]
pub mod BondingCurve {
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin_security::ReentrancyGuardComponent;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{
        ContractAddress, get_block_number, get_block_timestamp, get_caller_address, get_contract_address,
    };
    use crate::interfaces::{
        CurveBuy, CurveParams, CurveSell, CurveState, IBondingCurve, IBurnableDispatcher,
        IBurnableDispatcherTrait, IFeeVaultDispatcher, IFeeVaultDispatcherTrait, IGradLockerDispatcher,
        IGradLockerDispatcherTrait,
    };
    use crate::math::{BPS, ceil_div, check_curve_params, fee_up, mul_div, mul_div_up, product_ge};

    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        token: ContractAddress,
        currency: ContractAddress,
        fee_vault: ContractAddress,
        params: CurveParams,
        funded: bool, // the curve holds its tokens (checked once, on the first buy)
        k: u256,
        q: u256,
        t: u256,
        sold: u256,
        real: u256,
        fees: u256,
        open: bool,
        graduated: bool,
        locker: ContractAddress,
        factory: ContractAddress, // the deployer: its buys (the dev buy) pay the normal fee
        launch_block: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        Buy: Buy,
        Sell: Sell,
        Graduated: Graduated,
        FeesFlushed: FeesFlushed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Buy {
        #[key]
        pub buyer: ContractAddress,
        pub spent: u256,
        pub fee: u256,
        pub tokens: u256,
        pub q: u256,
        pub t: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Sell {
        #[key]
        pub seller: ContractAddress,
        pub tokens: u256,
        pub gross: u256,
        pub fee: u256,
        pub q: u256,
        pub t: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Graduated {
        pub locker: ContractAddress,
        pub tokens: u256,
        pub currency: u256,
        pub grad_fee: u256,
        pub burned: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct FeesFlushed {
        pub amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        token: ContractAddress,
        currency: ContractAddress,
        fee_vault: ContractAddress,
        locker: ContractAddress,
        params: CurveParams,
    ) {
        check_curve_params(@params);
        self.token.write(token);
        self.currency.write(currency);
        self.fee_vault.write(fee_vault);
        self.params.write(params);
        self.locker.write(locker);
        self.factory.write(get_caller_address());
        self.launch_block.write(get_block_number());
        self.k.write(params.v0 * params.t0);
        self.q.write(params.v0);
        self.t.write(params.t0);
        self.open.write(true);
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// The fee `buyer` pays now: the launch-window fee inside the window, except for the factory's dev buy.
        fn _buy_fee_bps(self: @ContractState, buyer: ContractAddress) -> u16 {
            let p = self.params.read();
            if buyer != self.factory.read()
                && get_block_number() < self.launch_block.read() + p.sniper_blocks {
                p.sniper_fee_bps
            } else {
                p.fee_bps
            }
        }

        fn _quote_buy(self: @ContractState, gross: u256, fee_bps: u16) -> CurveBuy {
            assert(self.open.read(), 'curve: closed');
            let p = self.params.read();
            assert(gross >= p.min_trade, 'curve: below minimum trade');
            let fee_bps: u256 = fee_bps.into();
            let (q, t, k) = (self.q.read(), self.t.read(), self.k.read());
            let mut fee = fee_up(gross, fee_bps);
            let mut net = gross - fee;
            let mut new_t = ceil_div(k, q + net);
            let mut out = t - new_t;
            let left = p.curve_tokens - self.sold.read();
            let mut spent = gross;
            if out >= left {
                // The last buy fills exactly the remaining tokens, at the smallest spend that pays for them.
                out = left;
                new_t = t - left;
                let need = ceil_div(k, new_t) - q;
                spent = mul_div_up(need, BPS, BPS - fee_bps);
                while spent - fee_up(spent, fee_bps) < need {
                    spent += 1;
                }
                assert(spent <= gross, 'curve: spend exceeds offer');
                fee = fee_up(spent, fee_bps);
                net = spent - fee;
            }
            assert(out > 0, 'curve: buys zero tokens');
            CurveBuy { out, spent, refund: gross - spent, fee, net, new_q: q + net, new_t }
        }

        fn _quote_sell(self: @ContractState, tokens: u256) -> CurveSell {
            assert(self.open.read(), 'curve: closed');
            assert(tokens > 0, 'curve: zero tokens');
            assert(tokens <= self.sold.read(), 'curve: sell exceeds sold');
            let p = self.params.read();
            let (q, t, k) = (self.q.read(), self.t.read(), self.k.read());
            let new_t = t + tokens;
            let new_q = ceil_div(k, new_t);
            let gross = q - new_q;
            let fee = fee_up(gross, p.fee_bps.into());
            // No minimum on sells: any sale that pays the seller something after the fee goes through.
            assert(gross > fee, 'curve: sell pays nothing');
            CurveSell { gross, fee, paid: gross - fee, new_q, new_t }
        }

        fn _erc20(self: @ContractState, address: ContractAddress) -> IERC20Dispatcher {
            IERC20Dispatcher { contract_address: address }
        }

        /// A buy (`buy`, `buy_and_graduate`). With `graduate`, it must take the last tokens, and then graduates.
        fn _buy(ref self: ContractState, gross: u256, min_out: u256, deadline: u64, graduate: bool) -> CurveBuy {
            self.reentrancy_guard.start();
            assert(get_block_timestamp() <= deadline, 'curve: expired');
            let buyer = get_caller_address();
            let r = self._quote_buy(gross, self._buy_fee_bps(buyer));
            assert(r.out >= min_out, 'curve: slippage');
            assert(product_ge(r.new_q, r.new_t, self.k.read(), 1), 'curve: invariant');
            if !self.funded.read() {
                // Tokens never leave the curve except to buyers and at graduation, so once is enough.
                let p = self.params.read();
                assert(
                    self
                        ._erc20(self.token.read())
                        .balance_of(get_contract_address()) >= p.curve_tokens + p.x_reserve,
                    'curve: not funded',
                );
                self.funded.write(true);
            }
            let sold = self.sold.read() + r.out;
            self.q.write(r.new_q);
            self.t.write(r.new_t);
            self.sold.write(sold);
            self.real.write(self.real.read() + r.net);
            self.fees.write(self.fees.read() + r.fee);
            if sold == self.params.read().curve_tokens {
                self.open.write(false);
            }
            // buy_and_graduate is only for the last buy (review b37a86c R1).
            assert(!graduate || !self.open.read(), 'curve: not the last buy');
            // Only what the trade costs is pulled; the buyer's remaining allowance is untouched.
            assert(
                self._erc20(self.currency.read()).transfer_from(buyer, get_contract_address(), r.spent),
                'curve: payment failed',
            );
            assert(self._erc20(self.token.read()).transfer(buyer, r.out), 'curve: token transfer failed');
            self
                .emit(
                    Buy {
                        buyer, spent: r.spent, fee: r.fee, tokens: r.out, q: r.new_q, t: r.new_t,
                    },
                );
            if graduate {
                // The last curve tokens, and the caller asked: graduate in the same call.
                self._graduate();
            }
            self.reentrancy_guard.end();
            r
        }

        /// Sends the reserve (minus the graduation fee) and the matching tokens to the locker, which opens the
        /// coin's Ekubo pool with them; burns the reserve tokens the pool doesn't need.
        fn _graduate(ref self: ContractState) -> ContractAddress {
            assert(!self.open.read(), 'curve: still selling');
            assert(!self.graduated.read(), 'curve: already graduated');
            let p = self.params.read();
            let real = self.real.read();
            let grad_fee = mul_div(real, p.grad_fee_bps.into(), BPS);
            let y = real - grad_fee;
            let x = mul_div(y, self.t.read(), self.q.read());
            // Both hold by construction (the constructor checked graduation_seed); kept as a last guard.
            assert(x > 0 && y > 0, 'curve: empty pool');
            assert(x <= p.x_reserve, 'curve: reserve too small');
            let burned = p.x_reserve - x;
            self.graduated.write(true);
            self.real.write(0);
            self.fees.write(self.fees.read() + grad_fee);

            let token = self.token.read();
            let locker = self.locker.read();
            assert(self._erc20(token).transfer(locker, x), 'curve: token transfer failed');
            assert(self._erc20(self.currency.read()).transfer(locker, y), 'curve: currency transfer failed');
            IGradLockerDispatcher { contract_address: locker }.graduate(token, x, y);
            if burned > 0 {
                IBurnableDispatcher { contract_address: token }.burn(burned);
            }
            self.emit(Graduated { locker, tokens: x, currency: y, grad_fee, burned });
            locker
        }
    }

    #[abi(embed_v0)]
    impl BondingCurveImpl of IBondingCurve<ContractState> {
        fn quote_buy(self: @ContractState, gross: u256) -> CurveBuy {
            self._quote_buy(gross, self._buy_fee_bps(get_caller_address()))
        }

        fn quote_sell(self: @ContractState, tokens: u256) -> CurveSell {
            self._quote_sell(tokens)
        }

        fn buy(ref self: ContractState, gross: u256, min_out: u256, deadline: u64) -> CurveBuy {
            self._buy(gross, min_out, deadline, false)
        }

        fn buy_and_graduate(ref self: ContractState, gross: u256, min_out: u256, deadline: u64) -> CurveBuy {
            self._buy(gross, min_out, deadline, true)
        }

        fn sell(ref self: ContractState, tokens: u256, min_paid: u256, deadline: u64) -> CurveSell {
            self.reentrancy_guard.start();
            assert(get_block_timestamp() <= deadline, 'curve: expired');
            let r = self._quote_sell(tokens);
            assert(r.paid >= min_paid, 'curve: slippage');
            assert(product_ge(r.new_q, r.new_t, self.k.read(), 1), 'curve: invariant');
            let seller = get_caller_address();
            self.q.write(r.new_q);
            self.t.write(r.new_t);
            self.sold.write(self.sold.read() - tokens);
            self.real.write(self.real.read() - r.gross);
            self.fees.write(self.fees.read() + r.fee);
            assert(
                self._erc20(self.token.read()).transfer_from(seller, get_contract_address(), tokens),
                'curve: token transfer failed',
            );
            assert(self._erc20(self.currency.read()).transfer(seller, r.paid), 'curve: payout failed');
            self
                .emit(
                    Sell { seller, tokens, gross: r.gross, fee: r.fee, q: r.new_q, t: r.new_t },
                );
            self.reentrancy_guard.end();
            r
        }

        fn graduate(ref self: ContractState) -> ContractAddress {
            self.reentrancy_guard.start();
            let locker = self._graduate();
            self.reentrancy_guard.end();
            locker
        }

        fn flush_fees(ref self: ContractState) -> u256 {
            self.reentrancy_guard.start();
            let amount = self.fees.read();
            if amount > 0 {
                self.fees.write(0);
                let vault = self.fee_vault.read();
                assert(self._erc20(self.currency.read()).approve(vault, amount), 'curve: approve failed');
                IFeeVaultDispatcher { contract_address: vault }.deposit(self.token.read(), amount);
                self.emit(FeesFlushed { amount });
            }
            self.reentrancy_guard.end();
            amount
        }

        fn state(self: @ContractState) -> CurveState {
            CurveState {
                q: self.q.read(),
                t: self.t.read(),
                sold: self.sold.read(),
                real: self.real.read(),
                fees: self.fees.read(),
                open: self.open.read(),
                graduated: self.graduated.read(),
                locker: self.locker.read(),
            }
        }

        fn params(self: @ContractState) -> CurveParams {
            self.params.read()
        }

        fn token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }

        fn currency(self: @ContractState) -> ContractAddress {
            self.currency.read()
        }

        fn launch_block(self: @ContractState) -> u64 {
            self.launch_block.read()
        }

        fn buy_fee_bps(self: @ContractState) -> u16 {
            self._buy_fee_bps(get_caller_address())
        }
    }
}
