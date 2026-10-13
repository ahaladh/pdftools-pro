import { create } from 'zustand';

/** Files chosen on the homepage, handed to the tool page the user picks next. */
interface PendingState {
  files: File[];
  set: (files: File[]) => void;
  take: () => File[];
}

export const usePending = create<PendingState>((set, get) => ({
  files: [],
  set: (files) => set({ files }),
  take: () => { const f = get().files; set({ files: [] }); return f; },
}));
