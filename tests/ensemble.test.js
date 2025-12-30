
import { classificationEnsemble } from '../../src/services/classificationEnsemble';

describe('DW-U4 Ensemble & Metrics Validation', () => {
  test('Majority vote should return consensus', () => {
    const inputs = [
      { name: 'Lavandula' },
      { name: 'Lavandula' },
      { name: 'Rosmarinus' }
    ];
    const vote = classificationEnsemble.getMajorityVote(inputs);
    expect(vote.consensus).toBe('Lavandula');
    expect(vote.agreement).toBeCloseTo(0.66);
  });

  test('F1 metric calculation should be mathematically sound', () => {
    const predictions = [true, true, false];
    const actual = [true, false, false];
    const metrics = classificationEnsemble.calculateMetrics(predictions, actual);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(1.0);
    expect(metrics.f1).toBeCloseTo(0.66);
  });
});
