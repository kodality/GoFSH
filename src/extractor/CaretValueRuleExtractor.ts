import { fhirtypes, fshtypes, utils } from 'fsh-sushi';
import { cloneDeep, isEqual, differenceWith, toPairs } from 'lodash';
import { ProcessableElementDefinition, ProcessableStructureDefinition } from '../processor';
import { ExportableCaretValueRule } from '../exportable';
import { getFSHValue, getPath, getPathValuePairs, logger, isFSHValueEmpty } from '../utils';

export class CaretValueRuleExtractor {
  static process(
    input: ProcessableElementDefinition,
    structDef: ProcessableStructureDefinition,
    fisher: utils.Fishable
  ): ExportableCaretValueRule[] {
    // Convert to json to remove extra private properties on fhirtypes.ElementDefinition
    const path = getPath(input);
    const inputJSON = input.toJSON() as any;
    input.processedPaths.push('id', 'path');
    const caretValueRules: ExportableCaretValueRule[] = [];
    const flatElementArray = toPairs(getPathValuePairs(inputJSON));
    const remainingFlatElementArray = flatElementArray.filter(
      ([key]) => !input.processedPaths.includes(key)
    );
    remainingFlatElementArray.forEach(([key], i) => {
      const caretValueRule = new ExportableCaretValueRule(path);
      caretValueRule.caretPath = key;
      caretValueRule.value = getFSHValue(i, remainingFlatElementArray, 'ElementDefinition', fisher);
      // If the value is empty, we can't use it. Log an error and give up on trying to use this key.
      if (isFSHValueEmpty(caretValueRule.value)) {
        logger.error(
          `Value in StructureDefinition ${structDef.name} for element ${path}.${key} is empty. No caret value rule will be created.`
        );
        return;
      }
      // Fix constraint[n] indices if applicable. This is necessary because GoFSH will use constraint indices relative
      // to the constraint array in the differential, which may be a *subset* of the constraint array in the snapshot.
      // SUSHI, however, processes indices relative to the constraint array in the snapshot, so we need to adjust for
      // what SUSHI expects. If we can't adjust (due to missing snapshot), log a warning and comment the FSH.
      const constraintMatch = key.match(/constraint\[(\d+)]/);
      if (constraintMatch) {
        let newIndex: number;
        if (structDef?.snapshot?.element?.length > 0) {
          const diffConstraint = inputJSON.constraint[parseInt(constraintMatch[1])];
          const snapElement = findMatchingSnapshot(inputJSON.id, structDef);
          newIndex = (snapElement?.constraint as any[])?.findIndex(
            c => c.key === diffConstraint.key
          );
        }
        if (newIndex != null) {
          caretValueRule.caretPath = key.replace(constraintMatch[0], `constraint[${newIndex}]`);
        } else {
          caretValueRule.fshComment =
            `WARNING: The constraint index in the following rule (e.g., ${constraintMatch[0]}) may be incorrect.\n` +
            "Please compare with the constraint array in the original definition's snapshot and adjust as necessary.";
          logger.warn(
            `Could not calculate correct constraint index relative to the snapshot for the following path in ${structDef.name}: ` +
              `${path} ^${key}. To resolve this issue, run GoFSH on definitions that include valid snapshots; otherwise check and fix ` +
              'constraint indices in the generated FSH files as necessary.'
          );
        }
      }

      // Fix mapping[n] indices for all the same reasons and with all the same behaviors as for constraint above.
      // Unfortunately, it's just different enough that extracting a common function would only add complexity.
      const mappingMatch = key.match(/mapping\[(\d+)]/);
      if (mappingMatch) {
        let newIndex: number;
        if (structDef?.snapshot?.element?.length > 0) {
          const diffMapping = inputJSON.mapping[parseInt(mappingMatch[1])];
          const snapElement = findMatchingSnapshot(inputJSON.id, structDef);
          // Unlike constraint, which has guaranteed unique keys, we need to compare mapping as a whole to find a match
          newIndex = (snapElement?.mapping as any[])?.findIndex(m => isEqual(m, diffMapping));
        }
        if (newIndex != null) {
          caretValueRule.caretPath = key.replace(mappingMatch[0], `mapping[${newIndex}]`);
        } else {
          caretValueRule.fshComment =
            `WARNING: The mapping index in the following rule (e.g., ${mappingMatch[0]}) may be incorrect.\n` +
            "Please compare with the mapping array in the original definition's snapshot and adjust as necessary.";
          logger.warn(
            `Could not calculate correct mapping index relative to the snapshot for the following path in ${structDef.name}: ` +
              `${path} ^${key}. To resolve this issue, run GoFSH on definitions that include valid snapshots; otherwise check and fix ` +
              'mapping indices in the generated FSH files as necessary.'
          );
        }
      }

      caretValueRules.push(caretValueRule);
    });
    return caretValueRules;
  }

  static processStructureDefinition(
    input: any,
    fisher: utils.Fishable,
    config: fshtypes.Configuration
  ): ExportableCaretValueRule[] {
    // Clone the input so we can modify it for simpler comparison
    const sd = cloneDeep(input);
    // Clone the parent so we can modify it for simpler comparison
    let parent = cloneDeep(
      fisher.fishForFHIR(
        input.baseDefinition,
        utils.Type.Resource,
        utils.Type.Type,
        utils.Type.Profile,
        utils.Type.Extension,
        utils.Type.Logical
      )
    );

    if (parent == null) {
      // We can't reliably export caret rules when we can't find the parent, but keep going
      // because we should still export the properties that SUSHI clears from the parent anyway
      // (properties that should always be exported).
      logger.warn(
        `Cannot reliably export top-level caret rules for ${sd.name} because GoFSH cannot find a ` +
          `definition for its parent: ${sd.baseDefinition}. If its parent is from another IG, ` +
          'run GoFSH again declaring that IG as a dependency.'
      );
      parent = cloneDeep(sd);
    }

    // Remove properties that are covered by other extractors or keywords
    RESOURCE_IGNORED_PROPERTIES['StructureDefinition'].forEach(prop => {
      delete sd[prop];
      delete parent[prop];
    });

    // If text exists and is generated, ignore it
    if (sd.text?.status === 'generated') {
      delete sd.text;
      delete parent.text;
    }

    // Remove properties from the parent that SUSHI clears before creating a profile. This
    // ensures that caret value rules will be exported even if the value is the same as the
    // parent (since SUSHI does not inherit these specific properties from the parent).
    // TODO: SUSHI should export the list of cleared properties or export a function that
    // clears them.
    SD_CLEARED_PROPERTIES.forEach(prop => delete parent[prop]);

    // Massage data to support arrays as best as possible. Unfortunately, FSH does not provide
    // full support for array manipulation. You cannot clear arrays, delete elements, replace
    // arrays, or append elements (unless you know the length). This makes things tricky for
    // GoFSH. For now we do the best we can, which is:
    // 1. If SD array and parent array are equal, do nothing (rely on inheritance)
    // 2. If SD array is subset of parent array, do nothing (FSH can't delete elements)
    // 3. If SD array is same length as parent array, but some elements differ, or if SD array
    //    is larger than the parent array:
    //    a. if extension or modifier extension, output caret rules for the whole array, because
    //       SUSHI modifies those arrays itself before applying rules, so the indices might be off
    //    b. otherwise output caret rules only for changed/added elements
    // To accomplish this, it's easier to manipulate the sd and parent JSON before flattening.
    // NOTE: This is only concerned w/ arrays at the top-level.
    Object.keys(sd).forEach(key => {
      if (Array.isArray(sd[key]) && sd[key].length) {
        let hasNewItems;
        if (Array.isArray(parent[key])) {
          const newItems = differenceWith(sd[key], parent[key], isEqual);
          hasNewItems = newItems.length > 0;
        } else {
          hasNewItems = true;
        }
        if (hasNewItems && (key === 'extension' || key === 'modifierExtension')) {
          // delete the items from the parent array, forcing the whole sd array to be exported
          delete parent[key];
        } else if (!hasNewItems) {
          // delete it from the SD so we won't create a caret rule for it even if it is a subset
          delete sd[key];
        }
      }
    });

    const caretValueRules: ExportableCaretValueRule[] = [];
    const flatSD = getPathValuePairs(sd);
    const flatArray = toPairs(flatSD);
    const flatParent = getPathValuePairs(parent);
    flatArray.forEach(([key], i) => {
      if (
        flatParent[key] == null ||
        !isEqual(flatSD[key], flatParent[key]) ||
        // SUSHI always sets status to active, so if it isn't active, we need a caret rule
        (key === 'status' && flatSD[key] !== 'active')
      ) {
        if (key === 'url' && this.isStandardURL('StructureDefinition', config, input)) {
          return;
        }
        const caretValueRule = new ExportableCaretValueRule('');
        caretValueRule.caretPath = key;
        caretValueRule.value = getFSHValue(i, flatArray, 'StructureDefinition', fisher);
        if (isFSHValueEmpty(caretValueRule.value)) {
          logger.error(
            `Value in StructureDefinition ${input.name} for element ${key} is empty. No caret value rule will be created.`
          );
        } else {
          caretValueRules.push(caretValueRule);
        }
      }
    });

    return caretValueRules;
  }

  static processResource(
    input: any,
    fisher: utils.Fishable,
    resourceType: 'ValueSet' | 'CodeSystem',
    config: fshtypes.Configuration
  ): ExportableCaretValueRule[] {
    const caretValueRules: ExportableCaretValueRule[] = [];
    const flatArray = toPairs(getPathValuePairs(input)).filter(
      ([key]) =>
        !RESOURCE_IGNORED_PROPERTIES[resourceType].some(
          property => key === property || new RegExp(`${property}(\\[\\d+\\])?\\.`).test(key)
        )
    );

    flatArray.forEach(([key], i) => {
      if (key === 'url' && this.isStandardURL(resourceType, config, input)) {
        return;
      }
      const caretValueRule = new ExportableCaretValueRule('');
      caretValueRule.caretPath = key;
      caretValueRule.value = getFSHValue(i, flatArray, resourceType, fisher);
      if (isFSHValueEmpty(caretValueRule.value)) {
        logger.error(
          `Value in ${resourceType} ${
            input.name ?? input.id
          } for element ${key} is empty. No caret value rule will be created.`
        );
      } else {
        caretValueRules.push(caretValueRule);
      }
    });
    return caretValueRules;
  }

  static processConcept(
    input: fhirtypes.CodeSystemConcept,
    conceptHierarchy: string[],
    codeSystemName: string,
    fisher: utils.Fishable
  ): ExportableCaretValueRule[] {
    const caretValueRules: ExportableCaretValueRule[] = [];
    const flatArray = toPairs(getPathValuePairs(input)).filter(
      ([key]) =>
        !CONCEPT_IGNORED_PROPERTIES.some(
          property => key === property || new RegExp(`${property}(\\[\\d+\\])?\\.`).test(key)
        )
    );
    flatArray.forEach(([key], i) => {
      const caretValueRule = new ExportableCaretValueRule('');
      caretValueRule.caretPath = key;
      caretValueRule.value = getFSHValue(i, flatArray, 'Concept', fisher);
      caretValueRule.isCodeCaretRule = true;
      caretValueRule.pathArray = conceptHierarchy;
      if (isFSHValueEmpty(caretValueRule.value)) {
        logger.error(
          `Value in CodeSytem ${codeSystemName} at concept ${conceptHierarchy.join(
            '.'
          )} for element ${caretValueRule.caretPath} is empty. No caret value rule will be created.`
        );
      } else {
        caretValueRules.push(caretValueRule);
      }
    });
    return caretValueRules;
  }

  static isStandardURL(resourceType: string, config: fshtypes.Configuration, input: any): boolean {
    return input.url == `${config.canonical}/${resourceType}/${input.id}`;
  }
}

function findMatchingSnapshot(differentialId: string, structDef: ProcessableStructureDefinition) {
  return structDef.snapshot?.element.find(el => {
    if (el.id === differentialId) {
      return true;
    } else if (el.id?.indexOf('[x]:') > 0) {
      // We may not have matched due to the alternate syntax for choices.  E.g., if the differential id is
      // Observation.valueQuantity but the snapshot id is Observation.value[x]:valueQuantity. Get the corresponding
      // alternate syntax for the id and test against that. See: https://blog.fire.ly/2019/09/13/type-slicing-in-fhir-r4/
      const elIdAltSyntax = (el.id as string)
        ?.split('.')
        .map(p => {
          const i = p.indexOf('[x]:');
          return i > -1 ? p.slice(i + 4) : p;
        })
        .join('.');
      return elIdAltSyntax === differentialId;
    }
    return false;
  });
}

const CONCEPT_IGNORED_PROPERTIES = ['code', 'display', 'definition', 'concept'];

const RESOURCE_IGNORED_PROPERTIES = {
  ValueSet: [
    'resourceType',
    'id',
    'name',
    'title',
    'description',
    'compose.include',
    'compose.exclude'
  ],
  CodeSystem: ['resourceType', 'id', 'name', 'title', 'description', 'concept'],
  StructureDefinition: [
    'resourceType',
    'id',
    'name',
    'title',
    'description',
    'fhirVersion',
    'mapping',
    'baseDefinition',
    'derivation',
    'snapshot',
    'differential'
  ]
};

// The properties that SUSHI clears before creating a profile
const SD_CLEARED_PROPERTIES = [
  'meta',
  'implicitRules',
  'language',
  'text',
  'contained',
  'identifier',
  'experimental',
  'date',
  'publisher',
  'contact',
  'useContext',
  'jurisdiction',
  'purpose',
  'copyright',
  'keyword'
];
