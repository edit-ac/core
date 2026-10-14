# FIT-1.7 canonical boundary

The standalone checker verifies deterministic lock/artifact inventory and notice
admission. The architecture suite uses that same production checker, plus frozen
missing-notice negatives and malformed input/advisory/family/artifact cases. It
emits the admitted inventory as `dependencies-inventory.json`; the dispatcher
retains exact test counts and implementation/input/artifact hashes.

Unavailable advisory sources and undistributed optional assets are explicit
inventory states, not skipped tests or supported release claims. Automated tests
never query advisory services: they validate the captured current response and
its lock/hash identity. Refresh the advisory record in a separate maintenance
step, then regenerate the inventory and validate both canonical commands.
