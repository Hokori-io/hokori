/// The launch factory: one call creates a coin, its bonding curve and its payee list, and makes the creator's
/// optional first buy in the same transaction, so nobody can buy ahead of the creator.
///
/// Every launch from a factory uses the same curve shape, fixed when the factory is deployed; it has no admin
/// and nothing about it can change. New parameters mean a new factory, so existing launches are never affected.
/// The factory deploys its own fee vault in its constructor and is that vault's only registrar. It never holds
/// funds between transactions: the dev buy's currency passes straight through, and unspent currency and the
/// bought tokens go back to the creator in the same call.
///
/// Every coin's address can be required to end in fixed hex digits (Hokori: "dab"). The coin is deployed at an
/// address derived from the creator's own address and a salt the creator chooses (found by search off chain); a
/// launch whose address doesn't end that way is refused.
///
/// Each launch may cost a fixed fee in currency (Hokori: none, owner 15 Oct; set when the factory is deployed), paid by the
/// creator to the protocol in the launch transaction, to make spam launches cost something.
///
/// Graduation (contract v2): the factory deploys its own Ekubo locker (`GradLocker`) in its constructor, after the
/// fee vault. Every coin's curve graduates into it, and it accepts graduation only from the curve recorded here for
/// that coin (`curve_of`, set as soon as the curve exists, so even a dev buy that sells out the curve graduates).
#[starknet::contract]
pub mod LaunchFactory {
    use core::num::traits::Zero;
    use core::pedersen::pedersen;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin_security::ReentrancyGuardComponent;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    use crate::interfaces::{
        CurveParams, IBondingCurveDispatcher, IBondingCurveDispatcherTrait, IFeeVaultDispatcher,
        IFeeVaultDispatcherTrait, ILaunchFactory, Launch,
    };
    use crate::ekubo::pool_fee_for;
    use crate::math::{check_curve_params, graduation_seed, mul_div};

    pub const MAX_NAME_BYTES: u32 = 64;
    pub const MAX_SYMBOL_BYTES: u32 = 16;
    pub const ARWEAVE_ID_CHARS: u32 = 43;
    pub const IPFS_CID_CHARS: u32 = 59; // "b" + base32 of the 36-byte raw sha2-256 CIDv1
    pub const MAX_SUFFIX_DIGITS: u8 = 16;
    /// Starknet's contract address derivation (as the deploy syscall computes it).
    const CONTRACT_ADDRESS_PREFIX: felt252 = 'STARKNET_CONTRACT_ADDRESS';
    const L2_ADDRESS_UPPER_BOUND: u256 = 0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00;

    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        currency: ContractAddress,
        token_class: ClassHash,
        curve_class: ClassHash,
        fee_vault: ContractAddress,
        locker: ContractAddress,
        curve_of: Map<ContractAddress, ContractAddress>,
        params: CurveParams,
        supply: u256,
        launch_count: u64,
        launches: Map<u64, Launch>,
        index_of: Map<ContractAddress, u64>, // token -> index + 1 (0: unknown)
        metadata: Map<ContractAddress, ByteArray>,
        address_suffix: felt252,
        address_suffix_digits: u8,
        launch_fee: u256,
        protocol: ContractAddress,
        max_dev_tokens: u256, // the most a launch's dev buy may take: max_dev_bps of the supply
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        LaunchCreated: LaunchCreated,
    }

    /// Everything an indexer needs to list a coin; the full payee list is in the fee vault's
    /// `PayeeRegistered` events.
    #[derive(Drop, starknet::Event)]
    pub struct LaunchCreated {
        #[key]
        pub token: ContractAddress,
        #[key]
        pub creator: ContractAddress,
        pub curve: ContractAddress,
        pub index: u64,
        pub name: ByteArray,
        pub symbol: ByteArray,
        pub metadata_uri: ByteArray,
        pub metadata_sha256: u256,
        pub dev_buy_spent: u256,
        pub dev_tokens: u256,
        pub launch_fee: u256,
    }

    /// Tokens to reserve for the pool: what graduation needs for a continuous price before any graduation fee
    /// (so at least what it needs after one), plus a 1 ppm (+1) margin; graduation burns whatever it doesn't use.
    /// Same arithmetic as qlp.curve_end_state.
    fn pool_reserve(p: @CurveParams) -> u256 {
        let g = graduation_seed(p);
        let x = mul_div(g.real, g.t_end, g.q_end);
        x + x / 1_000_000 + 1
    }

    /// The coin's constructor arguments: name, ticker, supply, and the factory as the first holder.
    fn token_calldata(
        name: @ByteArray, symbol: @ByteArray, supply: u256, factory: ContractAddress,
    ) -> Array<felt252> {
        let mut calldata: Array<felt252> = array![];
        name.serialize(ref calldata);
        symbol.serialize(ref calldata);
        supply.serialize(ref calldata);
        factory.serialize(ref calldata);
        calldata
    }

    fn starts_with(s: @ByteArray, prefix: @ByteArray) -> bool {
        if s.len() < prefix.len() {
            return false;
        }
        let mut i = 0;
        while i < prefix.len() {
            if s.at(i).unwrap() != prefix.at(i).unwrap() {
                return false;
            }
            i += 1;
        }
        true
    }

    /// The base64url value of an Arweave id character, if it is one.
    fn base64url_value(c: u8) -> Option<u32> {
        let c: u32 = c.into();
        if c >= 65 && c <= 90 {
            Option::Some(c - 65)
        } else if c >= 97 && c <= 122 {
            Option::Some(c - 97 + 26)
        } else if c >= 48 && c <= 57 {
            Option::Some(c - 48 + 52)
        } else if c == 45 {
            Option::Some(62)
        } else if c == 95 {
            Option::Some(63)
        } else {
            Option::None
        }
    }

    /// The lowercase RFC 4648 base32 value of a CID character, if it is one.
    fn base32_value(c: u8) -> Option<u64> {
        let c: u64 = c.into();
        if c >= 97 && c <= 122 {
            Option::Some(c - 97)
        } else if c >= 50 && c <= 55 {
            Option::Some(c - 50 + 26)
        } else {
            Option::None
        }
    }

    /// Pedersen hash of a list, Starknet style: h(...h(h(0, a0), a1)..., an-1), then hashed with the length.
    fn hash_on_elements(data: Span<felt252>) -> felt252 {
        let mut acc = 0;
        for x in data {
            acc = pedersen(acc, *x);
        }
        pedersen(acc, data.len().into())
    }

    /// The address the deploy syscall gives a contract (deployer, salt, class, constructor calldata).
    fn contract_address_for(
        deployer: ContractAddress, salt: felt252, class_hash: ClassHash, calldata: Span<felt252>,
    ) -> ContractAddress {
        let h = hash_on_elements(
            array![
                CONTRACT_ADDRESS_PREFIX, deployer.into(), salt, class_hash.into(),
                hash_on_elements(calldata),
            ]
                .span(),
        );
        let normalized: u256 = h.into() % L2_ADDRESS_UPPER_BOUND;
        let f: felt252 = normalized.try_into().unwrap();
        f.try_into().unwrap()
    }

    /// The salt a coin is deployed with: the creator's choice mixed with the creator's address.
    fn deploy_salt(creator: ContractAddress, salt: felt252) -> felt252 {
        poseidon_hash_span(array![creator.into(), salt].span())
    }

    fn pow16(digits: u8) -> u256 {
        let mut r: u256 = 1;
        for _ in 0..digits {
            r *= 16;
        }
        r
    }

    fn has_suffix(address: ContractAddress, suffix: felt252, digits: u8) -> bool {
        if digits == 0 {
            return true;
        }
        let a: felt252 = address.into();
        let a: u256 = a.into();
        let s: u256 = suffix.into();
        a % pow16(digits) == s
    }

    fn pow2(n: u32) -> u64 {
        let mut r: u64 = 1;
        for _ in 0..n {
            r *= 2;
        }
        r
    }

    /// `ar://` + the canonical base64url form of a 32-byte Arweave id: 43 characters, and the last one's two
    /// unused low bits zero (so each id has exactly one spelling).
    fn arweave_id_ok(uri: @ByteArray) -> bool {
        if uri.len() != 5 + ARWEAVE_ID_CHARS {
            return false;
        }
        let mut i = 5;
        let mut last: u32 = 0;
        while i < uri.len() {
            match base64url_value(uri.at(i).unwrap()) {
                Option::Some(v) => last = v,
                Option::None => { return false; },
            }
            i += 1;
        }
        last % 4 == 0
    }

    /// IPFS links are accepted in one canonical form only: CIDv1, multibase base32 lowercase ("b"), raw codec
    /// (0x55), sha2-256 multihash (0x12, 32 bytes): "bafkrei…", 59 characters. That is what IPFS gives a
    /// single-block file such as coin metadata (`ipfs add --cid-version=1`), and its digest IS the SHA-256 of
    /// the file. The CID is decoded completely (header bytes, canonical zero padding) and its digest returned;
    /// the caller requires it to equal the committed `metadata_sha256`. CIDv0 ("Qm…"), dag-pb ("bafybei…"),
    /// other bases and malformed strings are refused.
    fn ipfs_raw_cid_digest(uri: @ByteArray) -> Option<u256> {
        if uri.len() != 7 + IPFS_CID_CHARS || uri.at(7).unwrap() != 98 {
            return Option::None;
        }
        let mut acc: u64 = 0;
        let mut bits: u32 = 0;
        let mut index: u32 = 0; // decoded byte index
        let mut digest: u256 = 0;
        let mut ok = true;
        let mut i = 8;
        while i < uri.len() {
            match base32_value(uri.at(i).unwrap()) {
                Option::Some(v) => {
                    acc = acc * 32 + v;
                    bits += 5;
                    if bits >= 8 {
                        bits -= 8;
                        let p = pow2(bits);
                        let byte = acc / p;
                        acc = acc % p;
                        if index == 0 {
                            ok = ok && byte == 0x01; // CIDv1
                        } else if index == 1 {
                            ok = ok && byte == 0x55; // raw
                        } else if index == 2 {
                            ok = ok && byte == 0x12; // sha2-256
                        } else if index == 3 {
                            ok = ok && byte == 0x20; // 32-byte digest
                        } else {
                            digest = digest * 256 + byte.into();
                        }
                        index += 1;
                    }
                },
                Option::None => { return Option::None; },
            }
            i += 1;
        }
        // 58 characters carry 290 bits: 36 bytes plus 2 padding bits, which must be zero.
        if !ok || index != 36 || bits != 2 || acc != 0 {
            return Option::None;
        }
        Option::Some(digest)
    }

    /// The metadata commitment: a content-addressed link (canonical Arweave id, or a raw CIDv1 whose digest is
    /// the committed hash) and a non-zero SHA-256 of the exact bytes. An ordinary https URL (whose content can
    /// change), an empty link, or a malformed identifier is refused.
    fn check_metadata(uri: @ByteArray, sha256: u256) {
        assert(sha256 != 0, 'factory: metadata hash missing');
        if starts_with(uri, @"ar://") {
            assert(arweave_id_ok(uri), 'factory: metadata uri');
        } else if starts_with(uri, @"ipfs://") {
            match ipfs_raw_cid_digest(uri) {
                Option::Some(d) => assert(d == sha256, 'factory: cid != metadata hash'),
                Option::None => assert(false, 'factory: metadata uri'),
            }
        } else {
            assert(false, 'factory: metadata uri');
        }
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        currency: ContractAddress,
        token_class: ClassHash,
        curve_class: ClassHash,
        vault_class: ClassHash,
        locker_class: ClassHash,
        ekubo_core: ContractAddress,
        protocol: ContractAddress,
        protocol_bps: u16,
        params: CurveParams,
        address_suffix: felt252,
        address_suffix_digits: u8,
        launch_fee: u256,
        max_dev_bps: u16,
    ) {
        assert(params.curve_tokens > 0 && params.curve_tokens < params.t0, 'factory: bad curve shape');
        assert(max_dev_bps <= 10_000, 'factory: bad dev buy cap');
        assert(!protocol.is_zero(), 'factory: protocol is zero');
        self.launch_fee.write(launch_fee);
        self.protocol.write(protocol);
        assert(address_suffix_digits <= MAX_SUFFIX_DIGITS, 'factory: suffix too long');
        let suffix: u256 = address_suffix.into();
        assert(suffix < pow16(address_suffix_digits), 'factory: bad suffix');
        self.address_suffix.write(address_suffix);
        self.address_suffix_digits.write(address_suffix_digits);
        let mut params = params;
        params.x_reserve = pool_reserve(@params);
        // Every launch from this factory must be able to graduate: refuse unworkable settings up front.
        check_curve_params(@params);
        self.currency.write(currency);
        self.token_class.write(token_class);
        self.curve_class.write(curve_class);
        self.params.write(params);
        self.supply.write(params.curve_tokens + params.x_reserve);
        // The dev buy cap (Hokori 9.99% of the supply), fixed per factory.
        self.max_dev_tokens.write((params.curve_tokens + params.x_reserve) * max_dev_bps.into() / 10_000);

        let mut calldata: Array<felt252> = array![];
        get_contract_address().serialize(ref calldata); // the vault's registrar
        currency.serialize(ref calldata);
        protocol.serialize(ref calldata);
        protocol_bps.serialize(ref calldata);
        let (vault, _) = deploy_syscall(vault_class, 0, calldata.span(), false).unwrap_syscall();
        self.fee_vault.write(vault);

        // The Ekubo locker every coin graduates into (it registers itself with Ekubo as the pools' extension).
        let mut calldata: Array<felt252> = array![];
        ekubo_core.serialize(ref calldata);
        currency.serialize(ref calldata);
        vault.serialize(ref calldata);
        get_contract_address().serialize(ref calldata);
        pool_fee_for(params.fee_bps).serialize(ref calldata); // after graduation a trade pays what it paid on the curve
        let (locker, _) = deploy_syscall(locker_class, 0, calldata.span(), false).unwrap_syscall();
        self.locker.write(locker);
    }

    #[abi(embed_v0)]
    impl LaunchFactoryImpl of ILaunchFactory<ContractState> {
        fn launch(
            ref self: ContractState,
            name: ByteArray,
            symbol: ByteArray,
            metadata_uri: ByteArray,
            metadata_sha256: u256,
            payees: Array<ContractAddress>,
            shares_bps: Array<u16>,
            dev_buy: u256,
            min_dev_tokens: u256,
            salt: felt252,
            deadline: u64,
        ) -> Launch {
            self.reentrancy_guard.start();
            assert(get_block_timestamp() <= deadline, 'factory: expired');
            assert(name.len() > 0 && name.len() <= MAX_NAME_BYTES, 'factory: bad name');
            assert(symbol.len() > 0 && symbol.len() <= MAX_SYMBOL_BYTES, 'factory: bad symbol');
            check_metadata(@metadata_uri, metadata_sha256);
            let creator = get_caller_address();
            let me = get_contract_address();
            let index = self.launch_count.read();
            let supply = self.supply.read();
            let currency = self.currency.read();

            // 0. The launch fee, from the creator straight to the protocol (the whole launch reverts without it).
            let launch_fee = self.launch_fee.read();
            if launch_fee > 0 {
                assert(
                    IERC20Dispatcher { contract_address: currency }
                        .transfer_from(creator, self.protocol.read(), launch_fee),
                    'factory: launch fee failed',
                );
            }

            // 1. The coin, with its whole supply minted to the factory for the moment, at an address derived from
            //    the creator and their salt, which must end in this factory's required digits.
            let calldata = token_calldata(@name, @symbol, supply, me);
            let (token, _) = deploy_syscall(
                self.token_class.read(), deploy_salt(creator, salt), calldata.span(), false,
            )
                .unwrap_syscall();
            assert(
                has_suffix(token, self.address_suffix.read(), self.address_suffix_digits.read()),
                'factory: address suffix',
            );

            // 2. Its curve, then the whole supply into the curve.
            let mut calldata: Array<felt252> = array![];
            token.serialize(ref calldata);
            currency.serialize(ref calldata);
            self.fee_vault.read().serialize(ref calldata);
            self.locker.read().serialize(ref calldata);
            self.params.read().serialize(ref calldata);
            let (curve, _) = deploy_syscall(
                self.curve_class.read(), index.into(), calldata.span(), false,
            )
                .unwrap_syscall();
            self.curve_of.write(token, curve);
            let coin = IERC20Dispatcher { contract_address: token };
            assert(coin.transfer(curve, supply), 'factory: supply transfer failed');

            // 3. The payee list, fixed from now on (the vault checks count, shares and addresses).
            IFeeVaultDispatcher { contract_address: self.fee_vault.read() }
                .register(token, payees, shares_bps);

            // 4. The creator's dev buy, first in line.
            let mut dev_tokens: u256 = 0;
            let mut dev_spent: u256 = 0;
            if dev_buy > 0 {
                let money = IERC20Dispatcher { contract_address: currency };
                assert(money.transfer_from(creator, me, dev_buy), 'factory: dev buy payment failed');
                assert(money.approve(curve, dev_buy), 'factory: approve failed');
                // The creator's head start is capped: the dev buy is the cheapest buy anyone gets,
                // first in line and exempt from the launch-window fee. It's checked on the quote first, so an
                // oversized dev buy reverts before it buys anything; nothing can trade between the quote and the buy.
                let curve_d = IBondingCurveDispatcher { contract_address: curve };
                let quoted = curve_d.quote_buy(dev_buy);
                assert(quoted.out <= self.max_dev_tokens.read(), 'factory: dev buy over cap');
                // Inside the launch nothing can trade first, so the quote is exact: a dev buy that takes every curve
                // token (possible only under a cap of at least the curve's share) is the last buy, and graduates in
                // the launch; any other is a plain buy.
                let r = if quoted.out == self.params.read().curve_tokens {
                    curve_d.buy_and_graduate(dev_buy, min_dev_tokens, get_block_timestamp())
                } else {
                    curve_d.buy(dev_buy, min_dev_tokens, get_block_timestamp())
                };
                dev_tokens = r.out;
                dev_spent = r.spent;
                assert(money.approve(curve, 0), 'factory: approve failed');
                assert(coin.transfer(creator, r.out), 'factory: token transfer failed');
                if r.refund > 0 {
                    assert(money.transfer(creator, r.refund), 'factory: refund failed');
                }
            }

            let launch = Launch { token, curve, creator, dev_tokens, metadata_sha256 };
            self.launches.write(index, launch);
            self.index_of.write(token, index + 1);
            self.metadata.write(token, metadata_uri.clone());
            self.launch_count.write(index + 1);
            self
                .emit(
                    LaunchCreated {
                        token,
                        creator,
                        curve,
                        index,
                        name,
                        symbol,
                        metadata_uri,
                        metadata_sha256,
                        dev_buy_spent: dev_spent,
                        dev_tokens,
                        launch_fee,
                    },
                );
            self.reentrancy_guard.end();
            launch
        }

        fn address_rule(self: @ContractState) -> (felt252, u8) {
            (self.address_suffix.read(), self.address_suffix_digits.read())
        }

        fn token_address_for(
            self: @ContractState,
            creator: ContractAddress,
            salt: felt252,
            name: ByteArray,
            symbol: ByteArray,
        ) -> ContractAddress {
            let me = get_contract_address();
            let calldata = token_calldata(@name, @symbol, self.supply.read(), me);
            contract_address_for(me, deploy_salt(creator, salt), self.token_class.read(), calldata.span())
        }

        fn token_class(self: @ContractState) -> ClassHash {
            self.token_class.read()
        }

        fn launch_fee(self: @ContractState) -> u256 {
            self.launch_fee.read()
        }

        fn protocol(self: @ContractState) -> ContractAddress {
            self.protocol.read()
        }

        fn max_dev_tokens(self: @ContractState) -> u256 {
            self.max_dev_tokens.read()
        }

        fn launch_count(self: @ContractState) -> u64 {
            self.launch_count.read()
        }

        fn launch_at(self: @ContractState, index: u64) -> Launch {
            assert(index < self.launch_count.read(), 'factory: no such launch');
            self.launches.read(index)
        }

        fn launch_of(self: @ContractState, token: ContractAddress) -> Launch {
            let i = self.index_of.read(token);
            assert(i > 0, 'factory: unknown token');
            self.launches.read(i - 1)
        }

        fn curve_of(self: @ContractState, token: ContractAddress) -> ContractAddress {
            self.curve_of.read(token)
        }

        fn locker(self: @ContractState) -> ContractAddress {
            self.locker.read()
        }

        fn metadata_uri(self: @ContractState, token: ContractAddress) -> ByteArray {
            assert(self.index_of.read(token) > 0, 'factory: unknown token');
            self.metadata.read(token)
        }

        fn curve_params(self: @ContractState) -> CurveParams {
            self.params.read()
        }

        fn supply(self: @ContractState) -> u256 {
            self.supply.read()
        }

        fn fee_vault(self: @ContractState) -> ContractAddress {
            self.fee_vault.read()
        }

        fn currency(self: @ContractState) -> ContractAddress {
            self.currency.read()
        }
    }
}
