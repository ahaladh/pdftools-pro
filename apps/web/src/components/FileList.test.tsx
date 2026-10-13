import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileList } from './FileList';

const files = [new File(['a'], 'one.pdf'), new File(['b'], 'two.pdf'), new File(['c'], 'three.pdf')];

describe('FileList', () => {
  it('moves a file down with the keyboard-accessible button', async () => {
    const onChange = vi.fn();
    render(<FileList files={files} onChange={onChange} sortable />);
    await userEvent.click(screen.getByRole('button', { name: 'Move one.pdf down' }));
    expect(onChange.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['two.pdf', 'one.pdf', 'three.pdf']);
  });
  it('disables out-of-range moves', () => {
    render(<FileList files={files} onChange={() => undefined} sortable />);
    expect(screen.getByRole('button', { name: 'Move one.pdf up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move three.pdf down' })).toBeDisabled();
  });
  it('removes a file', async () => {
    const onChange = vi.fn();
    render(<FileList files={files} onChange={onChange} sortable={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove two.pdf' }));
    expect(onChange.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['one.pdf', 'three.pdf']);
  });
});
