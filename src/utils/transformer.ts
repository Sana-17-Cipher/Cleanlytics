export interface AggregationConfig {
  column: string;
  func: 'sum' | 'mean' | 'count' | 'min' | 'max';
  outputName: string;
}

// 1. Merge Columns
export function mergeColumns(
  rows: Record<string, any>[],
  sourceColumns: string[],
  targetColumn: string,
  delimiter: string
): Record<string, any>[] {
  return rows.map(row => {
    const mergedValue = sourceColumns
      .map(col => {
        const val = row[col];
        return val === null || val === undefined ? '' : String(val);
      })
      .join(delimiter);
      
    return {
      ...row,
      [targetColumn]: mergedValue
    };
  });
}

// 2. Split Column
export function splitColumn(
  rows: Record<string, any>[],
  sourceColumn: string,
  delimiter: string,
  targetColumns: string[]
): { rows: Record<string, any>[]; newHeaders: string[] } {
  const finalTargetColumns = targetColumns.map((col, idx) => col.trim() || `${sourceColumn}_split_${idx + 1}`);
  
  const updatedRows = rows.map(row => {
    const val = row[sourceColumn];
    const parts = val !== null && val !== undefined ? String(val).split(delimiter) : [];
    
    const splitObj: Record<string, any> = {};
    finalTargetColumns.forEach((colName, index) => {
      let partVal: any = parts[index];
      if (partVal === undefined || partVal === '') {
        partVal = null;
      }
      splitObj[colName] = partVal;
    });
    
    return {
      ...row,
      ...splitObj
    };
  });
  
  return {
    rows: updatedRows,
    newHeaders: finalTargetColumns
  };
}

// 3. Group By and Aggregate
export function groupByAggregate(
  rows: Record<string, any>[],
  groupByCols: string[],
  aggregations: AggregationConfig[]
): { rows: Record<string, any>[]; headers: string[] } {
  if (groupByCols.length === 0) {
    return { rows, headers: [] };
  }
  
  const groups: Record<string, { keys: Record<string, any>; values: Record<string, any>[] }> = {};
  
  // Group rows
  rows.forEach(row => {
    const groupKey = groupByCols.map(col => String(row[col] ?? 'null')).join('|||');
    if (!groups[groupKey]) {
      const keysObj: Record<string, any> = {};
      groupByCols.forEach(col => {
        keysObj[col] = row[col];
      });
      groups[groupKey] = {
        keys: keysObj,
        values: []
      };
    }
    groups[groupKey].values.push(row);
  });
  
  // Calculate aggregates for each group
  const resultRows = Object.values(groups).map(({ keys, values }) => {
    const aggregateObj: Record<string, any> = { ...keys };
    
    aggregations.forEach(agg => {
      const colVals = values
        .map(v => v[agg.column])
        .filter(v => v !== null && v !== undefined && !isNaN(Number(v)))
        .map(Number);
        
      let resultVal: any = null;
      
      if (agg.func === 'count') {
        // Count all values including null/undefined or count only non-null
        resultVal = values.filter(v => v[agg.column] !== null && v[agg.column] !== undefined).length;
      } else if (colVals.length > 0) {
        switch (agg.func) {
          case 'sum':
            resultVal = colVals.reduce((a, b) => a + b, 0);
            break;
          case 'mean':
            resultVal = colVals.reduce((a, b) => a + b, 0) / colVals.length;
            break;
          case 'min':
            resultVal = Math.min(...colVals);
            break;
          case 'max':
            resultVal = Math.max(...colVals);
            break;
        }
      }
      
      aggregateObj[agg.outputName] = resultVal;
    });
    
    return aggregateObj;
  });
  
  const headers = [...groupByCols, ...aggregations.map(a => a.outputName)];
  
  return {
    rows: resultRows,
    headers
  };
}

// 4. Calculated Columns
export function addCalculatedColumn(
  rows: Record<string, any>[],
  colA: string,
  colB: string,
  operator: '+' | '-' | '*' | '/' | 'concat',
  targetColumn: string
): Record<string, any>[] {
  return rows.map(row => {
    const valA = row[colA];
    const valB = row[colB];
    let result: any = null;
    
    if (operator === 'concat') {
      const strA = valA === null || valA === undefined ? '' : String(valA);
      const strB = valB === null || valB === undefined ? '' : String(valB);
      result = strA + strB;
    } else {
      const numA = valA !== null && valA !== undefined ? Number(valA) : NaN;
      const numB = valB !== null && valB !== undefined ? Number(valB) : NaN;
      
      if (!isNaN(numA) && !isNaN(numB)) {
        switch (operator) {
          case '+':
            result = numA + numB;
            break;
          case '-':
            result = numA - numB;
            break;
          case '*':
            result = numA * numB;
            break;
          case '/':
            result = numB !== 0 ? numA / numB : null;
            break;
        }
      }
    }
    
    return {
      ...row,
      [targetColumn]: result
    };
  });
}
