//! Opt-in benchmark observation. Absent from default engine builds.
use std::cell::Cell;
pub type Observer = fn(&'static str, Option<f64>) -> f64;
thread_local! { static OBSERVER: Cell<Option<Observer>> = const { Cell::new(None) }; }
pub struct ObserverGuard(Option<Observer>);
pub fn observe(observer: Observer) -> ObserverGuard {
    ObserverGuard(OBSERVER.with(|slot| slot.replace(Some(observer))))
}
impl Drop for ObserverGuard {
    fn drop(&mut self) {
        OBSERVER.with(|slot| slot.set(self.0));
    }
}
pub(crate) struct Span(&'static str, Option<(Observer, f64)>);
impl Span {
    pub(crate) fn new(operation: &'static str) -> Self {
        Self(
            operation,
            OBSERVER
                .with(|slot| slot.get())
                .map(|f| (f, f(operation, None))),
        )
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some((observer, start)) = self.1 {
            observer(self.0, Some(start));
        }
    }
}
