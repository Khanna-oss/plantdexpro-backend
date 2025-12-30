
import { youtubeThumbnailCache } from '../../src/services/youtubeThumbnailCache';

describe('YouTube Cache Service', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('should store and retrieve thumbnails', () => {
    youtubeThumbnailCache.set('123', 'http://thumb.com');
    expect(youtubeThumbnailCache.get('123')).toBe('http://thumb.com');
  });

  test('should return null for non-existent keys', () => {
    expect(youtubeThumbnailCache.get('999')).toBeNull();
  });
});
