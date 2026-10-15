export class FixtureReference<T> {
  private value: T | undefined;
  setValue(value: T): void {
    this.value = value;
  }
  getValue(): T {
    if (this.value === undefined) {
      throw new Error("Fixture has not been initialized");
    }
    return this.value;
  }
}
