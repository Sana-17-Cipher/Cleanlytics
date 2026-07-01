import * as XLSX from 'xlsx';

export interface ColumnStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
}

export type DataType = 'number' | 'string' | 'date' | 'boolean';

export interface Dataset {
  headers: string[];
  rows: Record<string, any>[];
  types: Record<string, DataType>;
  nullCounts: Record<string, number>;
  stats: Record<string, ColumnStats>;
  fileName: string;
  fileSize: number;
}

// Check if a value represents a date
function isDate(val: any): boolean {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return true;
  }
  if (typeof val === 'string') {
    // Regex for basic date formats like YYYY-MM-DD, MM/DD/YYYY, etc.
    const dateRegex = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
    const dateRegexSlash = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
    if (dateRegex.test(val.trim()) || dateRegexSlash.test(val.trim())) {
      const parsed = Date.parse(val);
      return !isNaN(parsed);
    }
  }
  return false;
}

// Parse value into JS types
function inferValueType(val: any): DataType {
  if (val === null || val === undefined) return 'string';
  if (typeof val === 'number') return 'number';
  if (typeof val === 'boolean') return 'boolean';
  if (isDate(val)) return 'date';
  
  // Try numeric parsing for strings
  const cleanedStr = String(val).trim();
  if (cleanedStr === '') return 'string';
  if (!isNaN(Number(cleanedStr)) && cleanedStr !== '') {
    return 'number';
  }
  if (cleanedStr.toLowerCase() === 'true' || cleanedStr.toLowerCase() === 'false') {
    return 'boolean';
  }
  
  return 'string';
}

export async function parseFile(file: File): Promise<Dataset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        
        if (workbook.SheetNames.length === 0) {
          throw new Error("The uploaded file does not contain any sheets.");
        }
        
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // Convert sheet to 2D array
        const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as any[][];
        if (sheetData.length === 0) {
          throw new Error("The sheet is empty.");
        }
        
        // Get headers and handle empty headers
        let headers = sheetData[0]?.map((h, i) => {
          const name = String(h || '').trim();
          return name ? name : `Column_${i + 1}`;
        }) || [];
        
        // Ensure headers are unique
        const seen: Record<string, number> = {};
        headers = headers.map(header => {
          if (seen[header] !== undefined) {
            seen[header]++;
            return `${header}_${seen[header]}`;
          }
          seen[header] = 0;
          return header;
        });

        // Convert rows to array of objects mapped to headers
        const rows = sheetData.slice(1).map((row, rIdx) => {
          const obj: Record<string, any> = {};
          headers.forEach((header, cIdx) => {
            let val = row[cIdx];
            if (val === undefined || val === '') {
              val = null;
            }
            obj[header] = val;
          });
          return obj;
        });
        
        // 1. Analyze column types based on values
        const types: Record<string, DataType> = {};
        const nullCounts: Record<string, number> = {};
        
        headers.forEach(header => {
          nullCounts[header] = 0;
          const typeCounts: Record<DataType, number> = { number: 0, string: 0, date: 0, boolean: 0 };
          let nonNullCount = 0;
          
          rows.forEach(row => {
            const val = row[header];
            if (val === null || val === undefined) {
              nullCounts[header]++;
            } else {
              nonNullCount++;
              const t = inferValueType(val);
              typeCounts[t]++;
            }
          });
          
          // Determine majority type, default to string
          if (nonNullCount === 0) {
            types[header] = 'string';
          } else {
            let maxType: DataType = 'string';
            let maxCount = 0;
            (Object.keys(typeCounts) as DataType[]).forEach(type => {
              if (typeCounts[type] > maxCount) {
                maxCount = typeCounts[type];
                maxType = type;
              }
            });
            types[header] = maxType;
          }
        });

        // Convert column values to inferred types where appropriate
        rows.forEach(row => {
          headers.forEach(header => {
            const val = row[header];
            if (val !== null && val !== undefined) {
              const targetType = types[header];
              if (targetType === 'number') {
                row[header] = Number(val);
              } else if (targetType === 'boolean') {
                row[header] = String(val).toLowerCase() === 'true' || val === true;
              } else if (targetType === 'date') {
                row[header] = val instanceof Date ? val : new Date(Date.parse(val));
              } else {
                row[header] = String(val);
              }
            }
          });
        });

        // 2. Compute numeric stats
        const stats: Record<string, ColumnStats> = {};
        headers.forEach(header => {
          if (types[header] === 'number') {
            const values = rows
              .map(row => row[header])
              .filter(val => typeof val === 'number' && !isNaN(val)) as number[];
              
            if (values.length > 0) {
              const min = Math.min(...values);
              const max = Math.max(...values);
              const sum = values.reduce((a, b) => a + b, 0);
              const mean = sum / values.length;
              
              // Median calculation
              const sorted = [...values].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
              
              // Standard Deviation
              const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
              const stdDev = Math.sqrt(variance);
              
              stats[header] = { min, max, mean, median, stdDev };
            }
          }
        });

        resolve({
          headers,
          rows,
          types,
          nullCounts,
          stats,
          fileName: file.name,
          fileSize: file.size
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

export function processDataset(data: Record<string, any>[], fileName: string, fileSize: number): Dataset {
  if (data.length === 0) {
    throw new Error("Dataset is empty.");
  }
  
  const headers = Object.keys(data[0]);
  const rows = data;
  
  const types: Record<string, DataType> = {};
  const nullCounts: Record<string, number> = {};
  
  headers.forEach(header => {
    nullCounts[header] = 0;
    const typeCounts: Record<DataType, number> = { number: 0, string: 0, date: 0, boolean: 0 };
    let nonNullCount = 0;
    
    rows.forEach(row => {
      const val = row[header];
      if (val === null || val === undefined) {
        nullCounts[header]++;
      } else {
        nonNullCount++;
        const t = inferValueType(val);
        typeCounts[t]++;
      }
    });
    
    if (nonNullCount === 0) {
      types[header] = 'string';
    } else {
      let maxType: DataType = 'string';
      let maxCount = 0;
      (Object.keys(typeCounts) as DataType[]).forEach(type => {
        if (typeCounts[type] > maxCount) {
          maxCount = typeCounts[type];
          maxType = type;
        }
      });
      types[header] = maxType;
    }
  });

  // Convert types inline for numbers
  rows.forEach(row => {
    headers.forEach(header => {
      const val = row[header];
      if (val !== null && val !== undefined) {
        const targetType = types[header];
        if (targetType === 'number' && typeof val !== 'number') {
           const num = Number(val);
           row[header] = isNaN(num) ? val : num;
        }
      }
    });
  });

  const stats: Record<string, ColumnStats> = {};
  headers.forEach(header => {
    if (types[header] === 'number') {
      const values = rows
        .map(row => row[header])
        .filter(val => typeof val === 'number' && !isNaN(val)) as number[];
        
      if (values.length > 0) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const sum = values.reduce((a, b) => a + b, 0);
        const mean = sum / values.length;
        
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);
        
        stats[header] = { min, max, mean, median, stdDev };
      }
    }
  });

  return {
    headers,
    rows,
    types,
    nullCounts,
    stats,
    fileName,
    fileSize
  };
}
