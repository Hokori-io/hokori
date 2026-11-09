/// Holds fees in currency for each coin's payees and the protocol, with individual claims and permissionless
/// distribution to registered payees. Each coin's payee list is registered once, by the launch factory, and never
/// changes. Every deposit gives the protocol its share first; the rest is split by the payees' basis points with
/// any rounding remainder to the last payee, so a deposit is always credited in full.
///
/// Balances are kept per (coin, recipient), and every credit and claim is an event, so a public ledger can show
/// for each coin exactly what each recipient was owed and paid. `PayeeRegistered` events carry the full list.
#[starknet::contract]
pub mod FeeVault {
    use core::num::traits::Zero;
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin_security::ReentrancyGuardComponent;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::interfaces::IFeeVault;
    use crate::fee_distribution::IFeeDistribution;
    use crate::math::{BPS, mul_div};

    pub const MAX_PAYEES: u32 = 10;

    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        registrar: ContractAddress,
        currency: ContractAddress,
        protocol: ContractAddress,
        protocol_bps: u16,
        payee_count: Map<ContractAddress, u32>,
        payee_at: Map<(ContractAddress, u32), (ContractAddress, u16)>,
        balances: Map<(ContractAddress, ContractAddress), u256>, // (coin, recipient)
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        PayeeRegistered: PayeeRegistered,
        Deposited: Deposited,
        Credited: Credited,
        Claimed: Claimed,
    }

    /// One per payee, in order, when a coin is registered.
    #[derive(Drop, starknet::Event)]
    pub struct PayeeRegistered {
        #[key]
        pub coin: ContractAddress,
        pub index: u32,
        pub payee: ContractAddress,
        pub share_bps: u16,
        pub count: u32, // how many payees the coin has
    }

    #[derive(Drop, starknet::Event)]
    pub struct Deposited {
        #[key]
        pub coin: ContractAddress,
        pub from: ContractAddress,
        pub amount: u256,
    }

    /// One per recipient (the protocol first) for each deposit; they sum to the deposit.
    #[derive(Drop, starknet::Event)]
    pub struct Credited {
        #[key]
        pub coin: ContractAddress,
        #[key]
        pub account: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Claimed {
        #[key]
        pub coin: ContractAddress,
        #[key]
        pub account: ContractAddress,
        pub amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        registrar: ContractAddress,
        currency: ContractAddress,
        protocol: ContractAddress,
        protocol_bps: u16,
    ) {
        assert(!protocol.is_zero(), 'vault: protocol is zero');
        assert(protocol_bps <= 5000, 'vault: protocol share too high');
        self.registrar.write(registrar);
        self.currency.write(currency);
        self.protocol.write(protocol);
        self.protocol_bps.write(protocol_bps);
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _credit(ref self: ContractState, coin: ContractAddress, account: ContractAddress, amount: u256) {
            if amount > 0 {
                self.balances.write((coin, account), self.balances.read((coin, account)) + amount);
                self.emit(Credited { coin, account, amount });
            }
        }
    }

    #[abi(embed_v0)]
    impl FeeDistributionImpl of IFeeDistribution<ContractState> {
        fn distribute(ref self: ContractState, coin: ContractAddress) -> u256 {
            self.reentrancy_guard.start();
            let n = self.payee_count.read(coin);
            assert(n > 0, 'vault: unknown coin');
            let protocol = self.protocol.read();
            let mut paid: u256 = 0;
            for i in 0..n {
                let (account, _) = self.payee_at.read((coin, i));
                // Protocol and creator allocations share a balance when the protocol is itself a payee.
                // Leave that entire balance to the existing protocol claim/split path.
                if account != protocol {
                    let amount = self.balances.read((coin, account));
                    if amount > 0 {
                        // Clear before the external call. A duplicate payee is consequently paid only once.
                        self.balances.write((coin, account), 0);
                        assert(
                            IERC20Dispatcher { contract_address: self.currency.read() }
                                .transfer(account, amount),
                            'vault: transfer failed',
                        );
                        self.emit(Claimed { coin, account, amount });
                        paid += amount;
                    }
                }
            }
            self.reentrancy_guard.end();
            paid
        }
    }

    #[abi(embed_v0)]
    impl FeeVaultImpl of IFeeVault<ContractState> {
        fn register(
            ref self: ContractState,
            coin: ContractAddress,
            payees: Array<ContractAddress>,
            shares_bps: Array<u16>,
        ) {
            assert(get_caller_address() == self.registrar.read(), 'vault: only the registrar');
            assert(self.payee_count.read(coin) == 0, 'vault: coin already registered');
            let n = payees.len();
            assert(n > 0 && n <= MAX_PAYEES, 'vault: 1 to 10 payees');
            assert(shares_bps.len() == n, 'vault: shares length mismatch');
            let mut total: u32 = 0;
            for i in 0..n {
                let payee = *payees.at(i);
                let share = *shares_bps.at(i);
                assert(!payee.is_zero(), 'vault: payee is zero');
                assert(share > 0, 'vault: zero share');
                total += share.into();
                self.payee_at.write((coin, i), (payee, share));
                self.emit(PayeeRegistered { coin, index: i, payee, share_bps: share, count: n });
            }
            assert(total == 10_000, 'vault: shares must sum to 100%');
            self.payee_count.write(coin, n);
        }

        fn deposit(ref self: ContractState, coin: ContractAddress, amount: u256) {
            self.reentrancy_guard.start();
            let n = self.payee_count.read(coin);
            assert(n > 0, 'vault: unknown coin');
            let from = get_caller_address();
            assert(
                IERC20Dispatcher { contract_address: self.currency.read() }
                    .transfer_from(from, get_contract_address(), amount),
                'vault: payment failed',
            );
            self.emit(Deposited { coin, from, amount });
            let protocol_cut = mul_div(amount, self.protocol_bps.read().into(), BPS);
            self._credit(coin, self.protocol.read(), protocol_cut);
            let rest = amount - protocol_cut;
            let mut credited: u256 = 0;
            for i in 0..n {
                let (payee, share) = self.payee_at.read((coin, i));
                let part = if i + 1 == n {
                    rest - credited
                } else {
                    mul_div(rest, share.into(), BPS)
                };
                credited += part;
                self._credit(coin, payee, part);
            }
            self.reentrancy_guard.end();
        }

        fn claim(ref self: ContractState, coin: ContractAddress) -> u256 {
            self.reentrancy_guard.start();
            let account = get_caller_address();
            let amount = self.balances.read((coin, account));
            if amount > 0 {
                self.balances.write((coin, account), 0);
                assert(
                    IERC20Dispatcher { contract_address: self.currency.read() }.transfer(account, amount),
                    'vault: transfer failed',
                );
                self.emit(Claimed { coin, account, amount });
            }
            self.reentrancy_guard.end();
            amount
        }

        fn balance_of(self: @ContractState, coin: ContractAddress, account: ContractAddress) -> u256 {
            self.balances.read((coin, account))
        }

        fn protocol(self: @ContractState) -> ContractAddress {
            self.protocol.read()
        }

        fn protocol_bps(self: @ContractState) -> u16 {
            self.protocol_bps.read()
        }

        fn payee_count(self: @ContractState, coin: ContractAddress) -> u32 {
            self.payee_count.read(coin)
        }

        fn payee_at(self: @ContractState, coin: ContractAddress, index: u32) -> (ContractAddress, u16) {
            assert(index < self.payee_count.read(coin), 'vault: index out of range');
            self.payee_at.read((coin, index))
        }
    }
}
