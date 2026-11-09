/// A launched coin: OpenZeppelin's ERC-20 with a fixed supply minted once, at deployment, to `recipient` (the
/// launch contract). No owner, no further minting, no pause, no blocklist, no transfer fee. Holders may burn
/// their own tokens (the sale contracts burn tokens they no longer need).
#[starknet::contract]
pub mod LaunchToken {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component, ERC20HooksEmptyImpl};
    use starknet::{ContractAddress, get_caller_address};

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        supply: u256,
        recipient: ContractAddress,
    ) {
        self.erc20.initializer(name, symbol);
        self.erc20.mint(recipient, supply);
    }

    #[abi(embed_v0)]
    impl BurnableImpl of crate::interfaces::IBurnable<ContractState> {
        fn burn(ref self: ContractState, amount: u256) {
            self.erc20.burn(get_caller_address(), amount);
        }
    }
}
