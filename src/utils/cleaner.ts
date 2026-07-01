import { ColumnStats } from './parser';

export type NullStrategy = 'drop' | 'mean' | 'median' | 'mode' | 'custom';

// Mode calculation helper
function getMode(arr: any[]): any {
  const valid = arr.filter(val => val !== null && val !== undefined && val !== '');
  if (valid.length === 0) return null;
  const counts: Record<string, number> = {};
  let maxVal = valid[0];
  let maxCount = 0;
  valid.forEach(val => {
    const str = String(val);
    counts[str] = (counts[str] || 0) + 1;
    if (counts[str] > maxCount) {
      maxCount = counts[str];
      maxVal = val;
    }
  });
  return maxVal;
}

// Date formatting helper
export function formatDateValue(val: any, formatStr: string): string {
  if (val === null || val === undefined) return '';
  const d = val instanceof Date ? val : new Date(Date.parse(val));
  if (isNaN(d.getTime())) return String(val);
  
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  
  switch (formatStr) {
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'DD-MM-YYYY':
      return `${dd}-${mm}-${yyyy}`;
    case 'YYYY-MM-DD HH:mm:ss':
      return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    default:
      return `${yyyy}-${mm}-${dd}`;
  }
}

// 1. Remove Duplicates
export function removeDuplicates(rows: Record<string, any>[], keyColumns?: string[]): Record<string, any>[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = keyColumns && keyColumns.length > 0 
      ? keyColumns.map(col => String(row[col] ?? '')).join('||')
      : JSON.stringify(row);
      
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// 2. Handle Null Values
export function handleNulls(
  rows: Record<string, any>[],
  column: string,
  strategy: NullStrategy,
  customValue?: any,
  stats?: ColumnStats
): Record<string, any>[] {
  if (strategy === 'drop') {
    return rows.filter(row => row[column] !== null && row[column] !== undefined && String(row[column]).trim() !== '');
  }
  
  let fillVal: any = null;
  
  if (strategy === 'custom') {
    fillVal = customValue;
  } else if (strategy === 'mean' && stats) {
    fillVal = stats.mean;
  } else if (strategy === 'median' && stats) {
    fillVal = stats.median;
  } else if (strategy === 'mode') {
    const colValues = rows.map(r => r[column]);
    fillVal = getMode(colValues);
  }
  
  return rows.map(row => {
    if (row[column] === null || row[column] === undefined || String(row[column]).trim() === '') {
      return { ...row, [column]: fillVal };
    }
    return { ...row };
  });
}

// 3. Format Dates
export function formatDates(
  rows: Record<string, any>[],
  column: string,
  formatStr: string
): Record<string, any>[] {
  return rows.map(row => {
    const val = row[column];
    if (val === null || val === undefined || String(val).trim() === '') {
      return { ...row };
    }
    try {
      const formatted = formatDateValue(val, formatStr);
      return { ...row, [column]: formatted };
    } catch {
      return { ...row };
    }
  });
}

// 4. Standardize Text (trim, remove extra spaces, remove special chars)
export function standardizeText(
  rows: Record<string, any>[],
  column: string,
  options: {
    trim?: boolean;
    removeExtraSpaces?: boolean;
    removeSpecialChars?: boolean;
  }
): Record<string, any>[] {
  return rows.map(row => {
    let val = row[column];
    if (val === null || val === undefined) return { ...row };
    
    let strVal = String(val);
    
    if (options.trim) {
      strVal = strVal.trim();
    }
    
    if (options.removeExtraSpaces) {
      strVal = strVal.replace(/\s+/g, ' ');
    }
    
    if (options.removeSpecialChars) {
      // Keep alphanumeric, spaces, and hyphens/underscores
      strVal = strVal.replace(/[^a-zA-Z0-9\s-_]/g, '');
    }
    
    return { ...row, [column]: strVal };
  });
}

// 5. Correct Casing
export function correctCasing(
  rows: Record<string, any>[],
  column: string,
  casingType: 'lower' | 'upper' | 'title'
): Record<string, any>[] {
  return rows.map(row => {
    const val = row[column];
    if (val === null || val === undefined) return { ...row };
    
    const strVal = String(val);
    let newVal = strVal;
    
    if (casingType === 'lower') {
      newVal = strVal.toLowerCase();
    } else if (casingType === 'upper') {
      newVal = strVal.toUpperCase();
    } else if (casingType === 'title') {
      newVal = strVal
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    return { ...row, [column]: newVal };
  });
}
