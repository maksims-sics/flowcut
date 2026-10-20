// Your edits with undo/redo. Three lists, one history:
//   edits:     { start, end, op: 'cut' | 'keep' }        applied over the auto cuts (silences, filler words)
//   gainEdits: { start, end, op: 'add', db } | { start, end, op: 'reset' }   louder moments
//   splits:    seconds where you pressed S: they only cut the timeline into pieces to toggle
// Times are source seconds. The engine applies the first two in order, so they survive any re-analysis.
export class EditHistory {
  constructor(onChange) {
    this.state = { edits: [], gainEdits: [], splits: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }

  get edits() { return this.state.edits; }
  get gainEdits() { return this.state.gainEdits; }
  get splits() { return this.state.splits; }

  reset({ edits = [], gainEdits = [], splits = [] } = {}) {
    this.state = { edits: edits.slice(), gainEdits: gainEdits.slice(), splits: splits.slice().sort((a, b) => a - b) };
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }

  /** One undo step: replace any of the lists. */
  commit(patch) {
    this.undoStack.push(this.state);
    this.state = { ...this.state, ...patch };
    this.redoStack = [];
    this.onChange();
  }

  addEdit(...edits) { if (edits.length) this.commit({ edits: [...this.state.edits, ...edits] }); }
  addGain(...gains) { if (gains.length) this.commit({ gainEdits: [...this.state.gainEdits, ...gains] }); }
  addSplit(t) { this.commit({ splits: [...this.state.splits, t].sort((a, b) => a - b) }); }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.state);
    this.state = this.undoStack.pop();
    this.onChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.state);
    this.state = this.redoStack.pop();
    this.onChange();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get count() { return this.state.edits.length + this.state.gainEdits.length + this.state.splits.length; }
}
