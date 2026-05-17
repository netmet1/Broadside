// Centralized entitlement gateway. All feature gating routes through
// `entitlement()`. In v0.1a alpha it always returns `Tier::Free` with every
// feature unlocked. The single-function pattern preserves optionality for
// future paid variants without scattered conditionals.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Free,
}

pub fn entitlement() -> Tier {
    Tier::Free
}
