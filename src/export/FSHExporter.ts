import table from 'text-table';
import { partition } from 'lodash';
import { EOL } from 'os';
import {
  Exportable,
  ExportableAlias,
  ExportableAssignmentRule,
  ExportableCaretValueRule,
  ExportableExtension,
  ExportableInstance,
  ExportableInvariant,
  ExportableObeysRule,
  ExportableProfile,
  NamedExportable
} from '../exportable';
import { Package } from '../processor';
import { logger } from '../utils';

export class FSHExporter {
  constructor(public readonly fshPackage: Package) {}

  export(style: string): Map<string, string> {
    let files: Map<string, Exportable[]>;
    switch (style) {
      case 'single-file':
        files = this.groupAsSingleFile();
        break;
      case 'group-by-fsh-type':
        files = this.groupByFSHType();
        break;
      case 'group-by-profile':
        files = this.groupByProfile();
        break;
      case 'file-per-definition':
        files = this.groupAsFilePerDefinition();
        break;
      default:
        if (style != null) {
          logger.warn(`Unrecognized output style "${style}". Defaulting to "by-category" style.`);
        }
        files = this.groupByFSHType();
    }

    logger.info(
      `Exported ${this.fshPackage.profiles.length} Profile${
        this.fshPackage.profiles.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.extensions.length} Extension${
        this.fshPackage.extensions.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.codeSystems.length} CodeSystem${
        this.fshPackage.codeSystems.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.valueSets.length} ValueSet${
        this.fshPackage.valueSets.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.instances.length} Instance${
        this.fshPackage.instances.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.invariants.length} Invariant${
        this.fshPackage.invariants.length == 1 ? '' : 's'
      }.`
    );
    logger.info(
      `Exported ${this.fshPackage.mappings.length} Mapping${
        this.fshPackage.mappings.length == 1 ? '' : 's'
      }.`
    );

    const writtenFiles: Map<string, string> = new Map();

    const index: string[][] = [];
    files.forEach((exportables, file) => {
      // Aliases are each their own "exportable", but should be joined together
      // by a single EOL, not double EOLs, and they should not be written in index.txt
      // so they are handled separately
      const [aliases, namedExportables] = partition(
        exportables,
        exportable => exportable instanceof ExportableAlias
      );
      const fileContent = [
        aliases.map(a => a.toFSH()).join(EOL),
        namedExportables.map(e => e.toFSH()).join(`${EOL}${EOL}`)
      ]
        .join(`${EOL}${EOL}`)
        .trim();
      // Ignore empty files, and don't write them to index.txt
      if (!fileContent) {
        return;
      }
      writtenFiles.set(file, fileContent);
      namedExportables.forEach((exportable: NamedExportable) => {
        // The index will have the name, FSH type, and file of the entity
        index.push([exportable.name, exportable.constructor.name.replace('Exportable', ''), file]);
      });
    });

    // Alphabetically sort the index by the name of the entity
    index.sort((line1, line2) => (line1[0] > line2[0] ? 1 : -1));
    index.unshift(['Name', 'Type', 'File']);
    writtenFiles.set('index.txt', table(index));

    return writtenFiles;
  }

  private groupAsSingleFile(): Map<string, Exportable[]> {
    const results: Exportable[] = [];
    results.push(...this.fshPackage.aliases);
    results.push(...this.fshPackage.profiles);
    results.push(...this.fshPackage.extensions);
    results.push(...this.fshPackage.codeSystems);
    results.push(...this.fshPackage.valueSets);
    results.push(...this.fshPackage.instances);
    results.push(...this.fshPackage.invariants);
    results.push(...this.fshPackage.mappings);
    return new Map().set('resources.fsh', results);
  }

  private groupAsFilePerDefinition(): Map<string, Exportable[]> {
    const files: Map<string, Exportable[]> = new Map();
    // Aliases, still get grouped into one file
    files.set('aliases.fsh', this.fshPackage.aliases);

    // Other definitions are each placed in an individual file
    for (const invariant of this.fshPackage.invariants) {
      files.set(`${invariant.name}-Invariant.fsh`, [invariant]);
    }
    for (const mapping of this.fshPackage.mappings) {
      files.set(`${mapping.name}-Mapping.fsh`, [mapping]);
    }
    for (const profile of this.fshPackage.profiles) {
      files.set(`${profile.name}-Profile.fsh`, [profile]);
    }
    for (const extension of this.fshPackage.extensions) {
      files.set(`${extension.name}-Extension.fsh`, [extension]);
    }
    for (const codeSystem of this.fshPackage.codeSystems) {
      files.set(`${codeSystem.name}-CodeSystem.fsh`, [codeSystem]);
    }
    for (const valueSet of this.fshPackage.valueSets) {
      files.set(`${valueSet.name}-ValueSet.fsh`, [valueSet]);
    }
    for (const instance of this.fshPackage.instances) {
      files.set(`${instance.name}-Instance.fsh`, [instance]);
    }

    return files;
  }

  private groupByFSHType(): Map<string, Exportable[]> {
    const files: Map<string, Exportable[]> = new Map();
    files.set('aliases.fsh', this.fshPackage.aliases);
    files.set('profiles.fsh', this.fshPackage.profiles);
    files.set('extensions.fsh', this.fshPackage.extensions);
    files.set('valueSets.fsh', this.fshPackage.valueSets);
    files.set('codeSystems.fsh', this.fshPackage.codeSystems);
    files.set('instances.fsh', this.fshPackage.instances);
    files.set('invariants.fsh', this.fshPackage.invariants);
    files.set('mappings.fsh', this.fshPackage.mappings);
    return files;
  }

  private groupByProfile(): Map<string, Exportable[]> {
    const files: Map<string, Exportable[]> = new Map();

    // Group profiles and examples of those profiles into individual files
    this.fshPackage.profiles.forEach(profile => {
      files.set(`${profile.name}.fsh`, [profile]);
    });

    files.set('instances.fsh', []);

    const [inlineInstances, nonInlineInstances] = partition(
      this.fshPackage.instances,
      i => i.usage === 'Inline'
    );
    // If a non-inline instance is an example of a profile, it is written to the file
    // for that profile. Otherwise it is written to instances.fsh
    nonInlineInstances.forEach(instance => {
      if (instance.usage === 'Example' && files.has(`${instance.instanceOf}.fsh`)) {
        files.get(`${instance.instanceOf}.fsh`).push(instance);
      } else {
        files.get('instances.fsh').push(instance);
      }
    });
    // Inline instances are written to the file they are used in, if they are only used
    // in one spot. Otherwise they go to instances.fsh
    inlineInstances.forEach(instance => {
      const usedIn = this.inlineInstanceUsedIn(instance, files);
      usedIn.length === 1
        ? files.get(usedIn[0]).push(instance)
        : files.get('instances.fsh').push(instance);
    });

    // Invariants are written to the same file as the profile they are used in, if they
    // are written in one spot. Otherwise they go to invariants.fsh.
    files.set('invariants.fsh', []);
    this.fshPackage.invariants.forEach(invariant => {
      const usedIn = this.invariantUsedIn(invariant, files);
      usedIn.length === 1
        ? files.get(usedIn[0]).push(invariant)
        : files.get('invariants.fsh').push(invariant);
    });

    // All other artifacts are grouped by category
    files.set('aliases.fsh', this.fshPackage.aliases);
    files.set('extensions.fsh', this.fshPackage.extensions);
    files.set('valueSets.fsh', this.fshPackage.valueSets);
    files.set('codeSystems.fsh', this.fshPackage.codeSystems);
    files.set('mappings.fsh', this.fshPackage.mappings);

    return files;
  }

  private inlineInstanceUsedIn(
    inlineInstance: ExportableInstance,
    files: Map<string, Exportable[]>
  ): string[] {
    const usedIn: string[] = [];
    files.forEach((exportables, file) => {
      exportables
        .filter(
          exportable =>
            exportable instanceof ExportableInstance ||
            exportable instanceof ExportableProfile ||
            exportable instanceof ExportableExtension
        )
        .forEach((resource: ExportableInstance | ExportableProfile | ExportableExtension) => {
          resource.rules.forEach(rule => {
            if (
              (rule instanceof ExportableAssignmentRule ||
                rule instanceof ExportableCaretValueRule) &&
              rule.isInstance &&
              rule.value === inlineInstance.name
            ) {
              usedIn.push(file);
            }
          });
        });
    });
    return usedIn;
  }

  private invariantUsedIn(
    invariant: ExportableInvariant,
    files: Map<string, Exportable[]>
  ): string[] {
    const usedIn: string[] = [];
    files.forEach((exportables, file) => {
      exportables
        .filter(exportable => exportable instanceof ExportableProfile)
        .forEach((profile: ExportableProfile) => {
          profile.rules.forEach(rule => {
            if (rule instanceof ExportableObeysRule && rule.keys.includes(invariant.name)) {
              usedIn.push(file);
            }
          });
        });
    });
    return usedIn;
  }
}
