export class RunIdentity {
  private generation = 0;
  begin() { this.generation += 1; return this.generation; }
  invalidate() { this.generation += 1; }
  isCurrent(generation: number) { return generation === this.generation; }
}
