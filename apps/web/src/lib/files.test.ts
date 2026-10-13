import { describe, it, expect } from 'vitest';
import { getTool } from '@pdftools/shared';
import { validateFile } from './files';

const f = (name: string, size = 10, type = '') => new File([new Uint8Array(size)], name, { type });
const merge = getTool('merge')!;
const img = getTool('images-to-pdf')!;

describe('validateFile', () => {
  it('accepts a PDF', () => expect(validateFile(f('a.pdf', 10, 'application/pdf'), merge, 1000)).toBeNull());
  it('rejects wrong type', () => expect(validateFile(f('a.exe'), merge, 1000)).toMatch(/not a supported/));
  it('rejects empty files', () => expect(validateFile(f('a.pdf', 0, 'application/pdf'), merge, 1000)).toMatch(/empty/));
  it('rejects oversize files', () => expect(validateFile(f('a.pdf', 2 * 1024 * 1024, 'application/pdf'), merge, 1024 * 1024)).toMatch(/limit/));
  it('accepts images for the image tool only', () => {
    expect(validateFile(f('a.JPG'), img, 1000)).toBeNull();
    expect(validateFile(f('a.png'), merge, 1000)).not.toBeNull();
  });
});
