export interface ConflictSection {
  ours: string;
  theirs: string;
  base?: string;
  startLine: number;
  endLine: number;
}

export class ConflictParser {
  private static readonly CONFLICT_START = /^<{7} (.+)$/;
  private static readonly CONFLICT_MIDDLE = /^={7}$/;
  private static readonly CONFLICT_BASE = /^\|{7} (.+)$/;
  private static readonly CONFLICT_END = /^>{7} (.+)$/;

  static hasConflictMarkers(content: string): boolean {
    return (
      content.includes("<<<<<<<") &&
      content.includes("=======") &&
      content.includes(">>>>>>>")
    );
  }

  static parseConflicts(content: string): ConflictSection[] {
    const lines = content.split("\n");
    const conflicts: ConflictSection[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (this.CONFLICT_START.test(line)) {
        const conflict = this.parseConflictSection(lines, i);
        if (conflict) {
          conflicts.push(conflict);
          i = conflict.endLine + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return conflicts;
  }

  private static parseConflictSection(
    lines: string[],
    startIndex: number,
  ): ConflictSection | null {
    const startLine = startIndex;
    let middleIndex = -1;
    let baseIndex = -1;
    let endIndex = -1;

    // Find the middle and end markers
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (this.CONFLICT_MIDDLE.test(lines[i]) && middleIndex === -1) {
        middleIndex = i;
      } else if (this.CONFLICT_BASE.test(lines[i]) && baseIndex === -1) {
        baseIndex = i;
      } else if (this.CONFLICT_END.test(lines[i])) {
        endIndex = i;
        break;
      }
    }

    if (middleIndex === -1 || endIndex === -1) {
      return null; // Invalid conflict section
    }

    // Extract sections
    const oursEnd = baseIndex !== -1 ? baseIndex : middleIndex;
    const theirsStart = middleIndex + 1;

    const ours = lines.slice(startIndex + 1, oursEnd).join("\n");
    const theirs = lines.slice(theirsStart, endIndex).join("\n");
    const base =
      baseIndex !== -1
        ? lines.slice(baseIndex + 1, middleIndex).join("\n")
        : undefined;

    return {
      ours,
      theirs,
      base,
      startLine,
      endLine: endIndex,
    };
  }

  static resolveConflicts(
    content: string,
    resolver: (conflict: ConflictSection) => string,
  ): string {
    const lines = content.split("\n");
    const conflicts = this.parseConflicts(content);

    // Process conflicts in reverse order to maintain line indices
    for (let i = conflicts.length - 1; i >= 0; i--) {
      const conflict = conflicts[i];
      const resolution = resolver(conflict);

      // Replace the conflict section with the resolution
      lines.splice(
        conflict.startLine,
        conflict.endLine - conflict.startLine + 1,
        ...resolution.split("\n"),
      );
    }

    return lines.join("\n");
  }
}
