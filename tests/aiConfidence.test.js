
import { aiConfidenceService } from '../../src/services/aiConfidenceService';

describe('AI Confidence Service', () => {
  test('should calculate correct score for high confidence', () => {
    const score = aiConfidenceService.calculateScore(0.9, 1.0, 'vision');
    expect(score).toBe(95); // 90 + 5
  });

  test('should penalize for low consistency', () => {
    const score = aiConfidenceService.calculateScore(0.8, 0.4, 'llm');
    expect(score).toBe(60); // 80 - 20
  });

  test('should detect generic phrases as hallucinations', () => {
    const text = "This plant is rich in vitamins and good for health.";
    expect(aiConfidenceService.detectHallucination(text)).toBe(true);
  });
});
