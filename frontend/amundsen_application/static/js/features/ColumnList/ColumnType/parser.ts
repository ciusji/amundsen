// Copyright Contributors to the Amundsen project.
// SPDX-License-Identifier: Apache-2.0

import { TableColumn } from 'interfaces/TableMetadata';

export type ParsedType = string | NestedType;

export interface NestedType {
  head: string;
  tail: string;
  children: ParsedType[];
  col_type?: string;
  name?: string;
}
enum DatabaseId {
  Hive = 'hive',
  Presto = 'presto',
  Delta = 'delta',
  Default = 'default',
}
const SUPPORTED_TYPES = {
  // https://cwiki.apache.org/confluence/display/Hive/LanguageManual+Types#LanguageManualTypes-ComplexTypes
  [DatabaseId.Hive]: ['array', 'map', 'struct', 'uniontype'],
  // https://prestosql.io/docs/current/language/types.html#structural
  [DatabaseId.Presto]: ['array', 'map', 'row'],
  // https://docs.databricks.com/spark/latest/spark-sql/language-manual/sql-ref-datatypes.html#data-types
  [DatabaseId.Delta]: ['array', 'map', 'struct'],
  [DatabaseId.Default]: ['array', 'map', 'struct', 'row', 'uniontype'],
};
const OPEN_DELIMETERS = {
  '(': ')',
  '<': '>',
  '[': ']',
};
const CLOSE_DELIMETERS = {
  ')': '(',
  '>': '<',
  ']': '[',
};
const SEPARATOR_DELIMETER = ',';
const COLUMN_TYPE_SEPARATOR = /:| /;

/*
 * Iterates through the columnType string and recursively creates a NestedType
 */
function parseNestedTypeHelper(
  columnType: string,
  startIndex: number = 0,
  currentIndex: number = 0
): { nextStartIndex: number; results: ParsedType[] } {
  const children: ParsedType[] = [];

  while (currentIndex < columnType.length) {
    const currentChar = columnType.charAt(currentIndex);

    if (currentChar === SEPARATOR_DELIMETER) {
      /* Case 1: End of non-nested item */
      children.push(columnType.substring(startIndex, currentIndex + 1).trim());
      startIndex = currentIndex + 1;
      currentIndex = startIndex;
    } else if (currentChar in CLOSE_DELIMETERS) {
      /* Case 2: End of a nested item  */
      if (startIndex !== currentIndex) {
        children.push(columnType.substring(startIndex, currentIndex).trim());
      }
      return {
        nextStartIndex: currentIndex + 1,
        results: children,
      };
    } else if (currentChar in OPEN_DELIMETERS) {
      /* Case 3: Beginning of a nested item */
      const nestedType = columnType.substring(startIndex, currentIndex);
      if (nestedType.endsWith('timestamp')) {
        /*
          Case 3.1: A non-supported item like timestamp() in Presto
          Advance until we reach the closing character for this item.
          On the next iteration Case 1 will apply.
        */
        while (
          columnType.charAt(currentIndex) !== OPEN_DELIMETERS[currentChar]
        ) {
          currentIndex++;
        }
        currentIndex++;
      } else {
        /* Case 3.2: A supported nested item */
        const parsedResults = parseNestedTypeHelper(
          columnType,
          currentIndex + 1,
          currentIndex + 1
        );
        let isLast: boolean = true;
        let { nextStartIndex } = parsedResults;
        const nestedString = columnType.substring(startIndex, nextStartIndex);
        if (columnType.charAt(nextStartIndex) === SEPARATOR_DELIMETER) {
          isLast = false;
          nextStartIndex++;
        }

        /*
          Case 3.3: A double nested type such as ARRAY(ROW(...))
          There is no column name for the nested ROW
        */
        const match = COLUMN_TYPE_SEPARATOR.exec(nestedString);
        const spaceIndex = match?.index || -1;
        let name = nestedString.substring(0, spaceIndex);
        let colType = nestedString.substring(spaceIndex + 1);
        if (
          name.indexOf('(') > 0 ||
          name.indexOf('<') > 0 ||
          name.indexOf('[') > 0
        ) {
          name = '';
          colType = '';
        }

        children.push({
          name,
          head: columnType.substring(startIndex, currentIndex + 1),
          col_type: colType,
          tail: `${OPEN_DELIMETERS[currentChar]}${
            isLast ? '' : SEPARATOR_DELIMETER
          }`,
          children: parsedResults.results,
        });

        startIndex = nextStartIndex;
        currentIndex = startIndex;
      }
    } else {
      currentIndex++;
    }
  }

  return {
    nextStartIndex: currentIndex + 1,
    results: children,
  };
}

/*
 * Returns whether or not a columnType string represents a complex type for the given database
 */
export function isNestedType(
  columnType: string,
  databaseId: string = DatabaseId.Default
): boolean {
  const supportedTypes = SUPPORTED_TYPES[databaseId];
  let isNested = false;
  if (supportedTypes) {
    supportedTypes.forEach((supportedType) => {
      if (
        columnType.startsWith(supportedType) &&
        columnType !== supportedType
      ) {
        isNested = true;
      }
    });
  }
  return isNested;
}

/**
 * Returns a NestedType object for supported complex types, else returns null
 */
export function parseNestedType(
  columnType: string,
  databaseId: string = DatabaseId.Default
): NestedType | null {
  // Presto includes un-needed "" characters
  if (databaseId === DatabaseId.Presto) {
    columnType = columnType.replace(/"/g, '');
  }
  if (isNestedType(columnType, databaseId)) {
    return parseNestedTypeHelper(columnType).results[0] as NestedType;
  }
  return null;
}

/**
 *
 * @param nestedType
 */
export function convertNestedTypeToColumns(
  nestedType: NestedType,
  nestedLevel: number = 1
): TableColumn[] {
  const { children } = nestedType;
  const nestedColumns: TableColumn[] = [];
  children.forEach((child) => {
    if (typeof child === 'string') {
      const [columnName, colType] = child.split(COLUMN_TYPE_SEPARATOR);
      if (colType !== undefined) {
        nestedColumns.push({
          badges: [],
          col_type: colType.replace(SEPARATOR_DELIMETER, ''),
          description: '',
          name: columnName,
          sort_order: 0,
          nested_level: nestedLevel,
          is_editable: false,
          stats: [],
        });
      }
    } else {
      if (child.name !== '') {
        nestedColumns.push({
          badges: [],
          col_type: child.col_type || '',
          description: '',
          name: child.name || '',
          sort_order: 0,
          nested_level: nestedLevel,
          is_editable: false,
          stats: [],
        });
        nestedLevel++;
      }
      const nestedChildren = convertNestedTypeToColumns(child, nestedLevel);
      nestedColumns.push(...nestedChildren);
    }
  });
  // Need to re-establish the sort order since this is built recursively.
  nestedColumns.forEach((column, index) => {
    column.sort_order = index;
  });
  return nestedColumns;
}

/*
 * Returns the truncated string representation for a NestedType
 */
export function getTruncatedText(nestedType: NestedType): string {
  const { head, tail } = nestedType;
  return `${head}...${tail.replace(SEPARATOR_DELIMETER, '')}`;
}
