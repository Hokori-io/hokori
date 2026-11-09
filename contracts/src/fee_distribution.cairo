/// Optional extension of FeeVault. Kept separate from IFeeVault so its existing dispatchers stay unchanged.
#[starknet::interface]
pub trait IFeeDistribution<TState> {
    /// Anyone may trigger payment to the registered payees; the caller cannot redirect funds or take a fee.
    /// Skips the protocol address, whose combined balance remains claimable through the protocol's own path.
    /// Returns the amount paid. Waiting curve/pool fees must be collected first by the calling transaction.
    fn distribute(ref self: TState, coin: starknet::ContractAddress) -> u256;
}
