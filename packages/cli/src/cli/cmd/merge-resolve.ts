import { Command } from "interactive-commander";
import Ora from "ora";
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import { ConflictResolver } from "../utils/merge-resolver";
import { ConflictParser } from "../utils/conflict-parser";

interface MergeResolveOptions {
  dryRun?: boolean;
  files?: string;
  strategy?: "smart" | "ours" | "theirs";
  verbose?: boolean;
  backup?: boolean;
}

export default new Command()
  .command("merge-resolve")
  .description(
    "Automatically resolve merge conflicts in lingo.dev meta.json and dictionary.js files",
  )
  .helpOption("-h, --help", "Show help")
  .option("--dry-run", "Show what would be resolved without making changes")
  .option(
    "--files <pattern>",
    "Specific file pattern to resolve (default: auto-detect)",
  )
  .option(
    "--strategy <strategy>",
    "Resolution strategy: smart, ours, theirs (default: smart)",
    "smart",
  )
  .option("--verbose", "Show detailed resolution steps")
  .option("--backup", "Create backup files before resolving")
  .action(async (options: MergeResolveOptions) => {
    const ora = Ora();

    try {
      ora.start("Scanning for merge conflicts in lingo.dev files...");

      // Find conflicted files
      const conflictedFiles = await findConflictedFiles(options.files);

      if (conflictedFiles.length === 0) {
        ora.succeed("No merge conflicts found in lingo.dev files");
        return;
      }

      ora.succeed(`Found ${conflictedFiles.length} conflicted file(s)`);

      if (options.verbose) {
        console.log("Conflicted files:");
        conflictedFiles.forEach((file) => console.log(`  - ${file}`));
      }

      const resolver = new ConflictResolver({
        strategy: options.strategy || "smart",
        verbose: options.verbose || false,
        dryRun: options.dryRun || false,
        backup: options.backup || false,
      });

      let resolvedCount = 0;
      let failedCount = 0;

      for (const filePath of conflictedFiles) {
        try {
          const fileOra = Ora({ indent: 2 });
          fileOra.start(`Resolving ${path.basename(filePath)}...`);

          const result = await resolver.resolveFile(filePath);

          if (result.success) {
            resolvedCount++;
            if (options.dryRun) {
              fileOra.succeed(
                `Would resolve ${path.basename(filePath)} (${result.conflictsResolved} conflicts)`,
              );
            } else {
              fileOra.succeed(
                `Resolved ${path.basename(filePath)} (${result.conflictsResolved} conflicts)`,
              );
            }

            if (options.verbose && result.details) {
              console.log(`    ${result.details}`);
            }
          } else {
            failedCount++;
            fileOra.fail(
              `Failed to resolve ${path.basename(filePath)}: ${result.error}`,
            );
          }
        } catch (error: any) {
          failedCount++;
          Ora({ indent: 2 }).fail(
            `Error processing ${path.basename(filePath)}: ${error.message}`,
          );
        }
      }

      // Summary
      console.log();
      if (options.dryRun) {
        ora.info(
          `Dry run complete: ${resolvedCount} files would be resolved, ${failedCount} failed`,
        );
      } else {
        if (resolvedCount > 0) {
          ora.succeed(`Successfully resolved ${resolvedCount} file(s)`);
        }
        if (failedCount > 0) {
          ora.warn(`Failed to resolve ${failedCount} file(s)`);
        }
      }
    } catch (error: any) {
      ora.fail(`Merge resolution failed: ${error.message}`);
      process.exit(1);
    }
  });

async function findConflictedFiles(pattern?: string): Promise<string[]> {
  const searchPatterns = pattern
    ? [pattern]
    : [
        "**/lingo/meta.json",
        "**/lingo/dictionary.js",
        "**/lingo/dictionary.ts",
      ];

  const allFiles: string[] = [];

  for (const searchPattern of searchPatterns) {
    const files = await glob(searchPattern, {
      cwd: process.cwd(),
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    allFiles.push(...files);
  }

  // Filter to only files with conflict markers
  const conflictedFiles: string[] = [];

  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      if (ConflictParser.hasConflictMarkers(content)) {
        conflictedFiles.push(file);
      }
    } catch (error) {
      // Skip files that can't be read
    }
  }

  return conflictedFiles;
}
