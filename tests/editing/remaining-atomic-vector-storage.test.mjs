import { registerAtomicVectorTests } from './atomic-vector-harness.mjs';
import { remainingVectorIds } from './atomic-vector-oracle.mjs';

registerAtomicVectorTests({ withStorage: true, vectorIds: remainingVectorIds, child: 'RGS-1.2-C21', artifact: 'remaining-atomic-vector-storage', suiteFile: 'tests/editing/remaining-atomic-vector-storage.test.mjs' });
