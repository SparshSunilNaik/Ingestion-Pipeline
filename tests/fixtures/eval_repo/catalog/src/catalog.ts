export class Catalog {
  private items: string[] = [];

  list(): string[] {
    return this.sorted();
  }

  private sorted(): string[] {
    return [...this.items].sort();
  }
}
