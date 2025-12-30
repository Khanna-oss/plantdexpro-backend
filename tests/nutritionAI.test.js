
import { validateNutritionAI } from '../../src/utils/validateNutritionAI';

describe('Nutrition AI Validator', () => {
  test('should reject objects with hallucinated filler', () => {
    const data = {
      nutrients: { vitamins: "Rich in vitamins", minerals: "Various minerals" },
      healthHints: [{ label: "Good", desc: "Good for health" }],
      specificUsage: "Consult doctor."
    };
    expect(validateNutritionAI(data)).toBeNull();
  });

  test('should accept specific valid data', () => {
    const data = {
      nutrients: { vitamins: "A, C, K", minerals: "Potassium, Magnesium" },
      healthHints: [{ label: "Anti-inflammatory", desc: "Reduces inflammation in tests." }],
      specificUsage: "Boil for 5 minutes."
    };
    expect(validateNutritionAI(data)).not.toBeNull();
  });
});
