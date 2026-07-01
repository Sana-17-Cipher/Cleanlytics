import { Dataset } from './parser';

export interface BusinessInsight {
  title: string;
  desc: string;
  category: 'Trends' | 'Performance' | 'Outliers' | 'Correlations';
  type: 'success' | 'warning' | 'info' | 'danger';
}

export interface BusinessReport {
  executiveSummary: string;
  keyMetrics: { label: string; value: string; desc: string }[];
  insightsList: BusinessInsight[];
}

export interface QueryResponse {
  answer: string;
  chartData?: any[];
  chartConfig?: {
    type: 'bar' | 'line' | 'pie' | 'kpi';
    xAxisKey?: string;
    yAxisKey?: string;
    title?: string;
  };
}

// Helper: Calculate Pearson Correlation
function getCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  
  let num = 0;
  let denX = 0;
  let denY = 0;
  
  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;
    num += diffX * diffY;
    denX += diffX * diffX;
    denY += diffY * diffY;
  }
  
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

// Helper: Fit simple linear regression
function fitRegression(x: number[], y: number[]): { slope: number; percentChange: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, percentChange: 0 };
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);
  
  // Percent change from start to end (fitted)
  const meanX = sumX / n;
  const meanY = sumY / n;
  const intercept = meanY - slope * meanX;
  const startVal = slope * x[0] + intercept;
  const endVal = slope * x[n - 1] + intercept;
  
  const percentChange = startVal !== 0 ? ((endVal - startVal) / Math.abs(startVal)) * 100 : 0;
  
  return { slope, percentChange };
}

// Main: Generate Insights
export function generateInsights(dataset: Dataset): BusinessReport {
  const { headers, rows, types, stats } = dataset;
  const insightsList: BusinessInsight[] = [];
  const keyMetrics: { label: string; value: string; desc: string }[] = [];
  
  if (rows.length === 0) {
    return {
      executiveSummary: "No records available to analyze. Please upload a dataset.",
      keyMetrics: [],
      insightsList: []
    };
  }

  // 1. Basic metrics (Total rows, Numeric column totals)
  keyMetrics.push({
    label: "Total Records",
    value: rows.length.toLocaleString(),
    desc: "Count of items in current dataset"
  });

  const numericCols = headers.filter(h => types[h] === 'number');
  const dateCols = headers.filter(h => types[h] === 'date');
  const stringCols = headers.filter(h => types[h] === 'string');

  // Sum up key numeric columns
  const firstNumeric = numericCols[0];
  const secondNumeric = numericCols[1];
  
  numericCols.forEach(col => {
    const sum = rows.reduce((acc, row) => acc + (Number(row[col]) || 0), 0);
    const mean = stats[col]?.mean ?? 0;
    if (col.toLowerCase().includes('sales') || col.toLowerCase().includes('revenue') || col.toLowerCase().includes('amount')) {
      keyMetrics.push({
        label: `Total ${col}`,
        value: `$${sum.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
        desc: `Sum of all values in ${col}`
      });
    }
  });

  // 2. Trend detection
  if (dateCols.length > 0 && firstNumeric) {
    const dateCol = dateCols[0];
    // Sort rows by date
    const sortedRows = [...rows]
      .filter(r => r[dateCol] instanceof Date && !isNaN((r[dateCol] as Date).getTime()))
      .sort((a, b) => (a[dateCol] as Date).getTime() - (b[dateCol] as Date).getTime());
      
    if (sortedRows.length >= 5) {
      // Group by month
      const monthlyGroups: Record<string, number[]> = {};
      sortedRows.forEach(r => {
        const d = r[dateCol] as Date;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyGroups[key]) monthlyGroups[key] = [];
        monthlyGroups[key].push(Number(r[firstNumeric]) || 0);
      });
      
      const months = Object.keys(monthlyGroups).sort();
      const monthSums = months.map(m => monthlyGroups[m].reduce((a, b) => a + b, 0));
      
      if (months.length >= 2) {
        const xIndices = months.map((_, idx) => idx);
        const { slope, percentChange } = fitRegression(xIndices, monthSums);
        
        const direction = slope > 0 ? "growth" : "decline";
        const type = slope > 0 ? 'success' : 'warning';
        
        insightsList.push({
          title: `${firstNumeric} Trend Over Time`,
          desc: `The month-over-month regression line for ${firstNumeric} indicates a ${direction} of approximately ${Math.abs(percentChange).toFixed(1)}% across the tracked timeframe (${months[0]} to ${months[months.length - 1]}).`,
          category: 'Trends',
          type: type
        });
      }
    }
  }

  // 3. Category performance
  if (stringCols.length > 0 && firstNumeric) {
    // Rank top categories by summing firstNumeric
    const catCol = stringCols.find(col => {
      const lower = col.toLowerCase();
      return lower.includes('category') || lower.includes('product') || lower.includes('region') || lower.includes('country') || lower.includes('name') || lower.includes('type');
    }) || stringCols[0];
    
    const catSums: Record<string, number> = {};
    let totalNumericSum = 0;
    
    rows.forEach(row => {
      const cat = String(row[catCol] ?? 'Unknown');
      const val = Number(row[firstNumeric]) || 0;
      catSums[cat] = (catSums[cat] || 0) + val;
      totalNumericSum += val;
    });
    
    const sortedCats = Object.entries(catSums).sort((a, b) => b[1] - a[1]);
    
    if (sortedCats.length > 0 && totalNumericSum > 0) {
      const [topCat, topVal] = sortedCats[0];
      const percentage = (topVal / totalNumericSum) * 100;
      
      insightsList.push({
        title: `Dominant Category in ${catCol}`,
        desc: `"${topCat}" is the leading category by ${firstNumeric}, contributing $${topVal.toLocaleString(undefined, { maximumFractionDigits: 0 })} or ${percentage.toFixed(1)}% of the total aggregate.`,
        category: 'Performance',
        type: 'success'
      });
      
      if (sortedCats.length > 2) {
        const [lowestCat, lowestVal] = sortedCats[sortedCats.length - 1];
        const lowPercentage = (lowestVal / totalNumericSum) * 100;
        insightsList.push({
          title: `Lowest Category in ${catCol}`,
          desc: `"${lowestCat}" ranks lowest in ${firstNumeric}, representing only $${lowestVal.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${lowPercentage.toFixed(1)}% of total). This may represent an opportunity for optimization or consolidation.`,
          category: 'Performance',
          type: 'warning'
        });
      }
    }
  }

  // 4. Outlier detection
  if (firstNumeric && stats[firstNumeric]) {
    const colStats = stats[firstNumeric];
    // IQR outlier bounds
    const q1 = colStats.mean - (0.675 * colStats.stdDev); // approximation if normal
    const q3 = colStats.mean + (0.675 * colStats.stdDev);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    
    const outliers = rows.filter(r => {
      const val = Number(r[firstNumeric]);
      return !isNaN(val) && (val < lowerBound || val > upperBound);
    });
    
    if (outliers.length > 0) {
      const pctOutliers = (outliers.length / rows.length) * 100;
      insightsList.push({
        title: `Outliers Detected in ${firstNumeric}`,
        desc: `Found ${outliers.length} statistical anomaly data points (${pctOutliers.toFixed(1)}% of rows) with values significantly deviating from the typical range (below $${lowerBound.toFixed(0)} or above $${upperBound.toFixed(0)}).`,
        category: 'Outliers',
        type: outliers.length > rows.length * 0.05 ? 'danger' : 'warning'
      });
    }
  }

  // 5. Correlation Finder
  if (numericCols.length >= 2) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < numericCols.length; i++) {
      for (let j = i + 1; j < numericCols.length; j++) {
        pairs.push([numericCols[i], numericCols[j]]);
      }
    }
    
    pairs.forEach(([colA, colB]) => {
      const valA = rows.map(r => Number(r[colA])).filter(v => !isNaN(v));
      const valB = rows.map(r => Number(r[colB])).filter(v => !isNaN(v));
      
      if (valA.length === valB.length && valA.length > 5) {
        const corr = getCorrelation(valA, valB);
        if (Math.abs(corr) >= 0.4) {
          const strength = Math.abs(corr) >= 0.7 ? "strong" : "moderate";
          const direction = corr > 0 ? "positive" : "negative";
          const desc = corr > 0 
            ? `As ${colA} increases, ${colB} tends to increase as well (Pearson r = ${corr.toFixed(2)}).`
            : `As ${colA} increases, ${colB} tends to decrease (Pearson r = ${corr.toFixed(2)}).`;
            
          insightsList.push({
            title: `Correlation: ${colA} & ${colB}`,
            desc: `There is a ${strength} ${direction} correlation between ${colA} and ${colB}. ${desc}`,
            category: 'Correlations',
            type: 'info'
          });
        }
      }
    });
  }

  // Executive Summary drafting
  let summary = `Cleanlytics finished processing the dataset "${dataset.fileName}" (${rows.length} rows, ${headers.length} columns). `;
  if (insightsList.length > 0) {
    summary += `We discovered ${insightsList.length} key patterns in your data. `;
    const trend = insightsList.find(i => i.category === 'Trends');
    const perf = insightsList.find(i => i.category === 'Performance');
    
    if (perf) {
      summary += `Notably, ${perf.desc} `;
    }
    if (trend) {
      summary += `Analyzing time-series trends, ${trend.desc} `;
    }
  } else {
    summary += "No strong statistical trends, anomalies, or correlation patterns were identified in this dataset.";
  }

  return {
    executiveSummary: summary,
    keyMetrics,
    insightsList
  };
}

// Conversational AI Q&A Engine
export function answerQuery(dataset: Dataset, query: string): QueryResponse {
  const lowerQuery = query.toLowerCase().trim();
  const { headers, rows, types } = dataset;
  
  if (rows.length === 0) {
    return { answer: "Please upload a dataset first so that I can analyze it." };
  }

  const numericCols = headers.filter(h => types[h] === 'number');
  const dateCols = headers.filter(h => types[h] === 'date');
  const stringCols = headers.filter(h => types[h] === 'string');

  const mainNumeric = numericCols[0];
  const mainString = stringCols.find(col => {
    const l = col.toLowerCase();
    return l.includes('category') || l.includes('product') || l.includes('region') || l.includes('segment');
  }) || stringCols[0];
  const mainDate = dateCols[0];

  // 1. Question: Best/Top Category
  if (
    lowerQuery.includes('best') || 
    lowerQuery.includes('top') || 
    lowerQuery.includes('highest') || 
    lowerQuery.includes('most') ||
    lowerQuery.includes('leader')
  ) {
    if (mainString && mainNumeric) {
      // Find category with highest sum
      const catSums: Record<string, number> = {};
      rows.forEach(r => {
        const cat = String(r[mainString] ?? 'Unknown');
        const val = Number(r[mainNumeric]) || 0;
        catSums[cat] = (catSums[cat] || 0) + val;
      });
      
      const sorted = Object.entries(catSums).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        const [topCat, topVal] = sorted[0];
        const chartData = sorted.slice(0, 10).map(([name, value]) => ({
          name,
          value
        }));
        
        let answerText = `Based on the analysis, **${topCat}** is the top-performing item in the **${mainString}** column, with a total **${mainNumeric}** of **$${topVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}**.`;
        if (sorted.length > 1) {
          answerText += `\n\nHere are the top categories ranked:\n` + 
            sorted.slice(0, 5).map((item, idx) => `${idx + 1}. **${item[0]}**: $${item[1].toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join('\n');
        }
        
        return {
          answer: answerText,
          chartData,
          chartConfig: {
            type: 'bar',
            xAxisKey: 'name',
            yAxisKey: 'value',
            title: `Top 10 ${mainString} by ${mainNumeric}`
          }
        };
      }
    }
  }

  // 2. Question: Trend / Time-series
  if (
    lowerQuery.includes('trend') || 
    lowerQuery.includes('over time') || 
    lowerQuery.includes('monthly') || 
    lowerQuery.includes('growth') ||
    lowerQuery.includes('sales path')
  ) {
    if (mainDate && mainNumeric) {
      // Group by date
      const timeGroups: Record<string, number[]> = {};
      rows.forEach(r => {
        const val = r[mainDate];
        let key = '';
        if (val instanceof Date) {
          key = `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}`;
        } else {
          const parsed = new Date(Date.parse(val));
          if (!isNaN(parsed.getTime())) {
            key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
          }
        }
        if (key) {
          if (!timeGroups[key]) timeGroups[key] = [];
          timeGroups[key].push(Number(r[mainNumeric]) || 0);
        }
      });
      
      const sortedKeys = Object.keys(timeGroups).sort();
      const chartData = sortedKeys.map(key => ({
        date: key,
        value: timeGroups[key].reduce((a, b) => a + b, 0)
      }));
      
      if (chartData.length > 0) {
        const start = chartData[0];
        const end = chartData[chartData.length - 1];
        const change = ((end.value - start.value) / (start.value || 1)) * 100;
        const trendDirection = change > 0 ? "increased" : "decreased";
        
        return {
          answer: `Here is the monthly **${mainNumeric}** trend timeline. The data spans from **${start.date}** ($${start.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}) to **${end.date}** ($${end.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}).\n\nOverall, aggregate values have **${trendDirection}** by **${Math.abs(change).toFixed(1)}%** between the starting and ending months.`,
          chartData,
          chartConfig: {
            type: 'line',
            xAxisKey: 'date',
            yAxisKey: 'value',
            title: `Monthly ${mainNumeric} Trend`
          }
        };
      }
    }
  }

  // 3. Question: Outliers
  if (
    lowerQuery.includes('outlier') || 
    lowerQuery.includes('anomaly') || 
    lowerQuery.includes('abnormal') ||
    lowerQuery.includes('unusual')
  ) {
    if (mainNumeric && dataset.stats[mainNumeric]) {
      const colStats = dataset.stats[mainNumeric];
      const q1 = colStats.mean - (0.675 * colStats.stdDev);
      const q3 = colStats.mean + (0.675 * colStats.stdDev);
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      
      const anomalies = rows
        .map((r, index) => ({ ...r, __index: index + 1 }))
        .filter(r => {
          const val = Number(r[mainNumeric]);
          return !isNaN(val) && (val < lower || val > upper);
        });
        
      if (anomalies.length > 0) {
        let text = `Yes! I found **${anomalies.length}** statistical outlier(s) in the **${mainNumeric}** column (values outside the range $${lower.toFixed(0)} to $${upper.toFixed(0)}):\n\n`;
        anomalies.slice(0, 5).forEach((anom, idx) => {
          const detailStr = mainString ? ` (${mainString}: "${anom[mainString]}")` : '';
          text += `${idx + 1}. Row #${anom.__index}: **$${Number(anom[mainNumeric]).toLocaleString()}** ${detailStr}\n`;
        });
        if (anomalies.length > 5) {
          text += `... and ${anomalies.length - 5} more.`;
        }
        
        const chartData = anomalies.slice(0, 10).map(anom => ({
          name: `Row ${anom.__index}`,
          value: Number(anom[mainNumeric])
        }));
        
        return {
          answer: text,
          chartData,
          chartConfig: {
            type: 'bar',
            xAxisKey: 'name',
            yAxisKey: 'value',
            title: `Statistical Outliers in ${mainNumeric}`
          }
        };
      } else {
        return {
          answer: `No statistical outliers were detected in the **${mainNumeric}** column. All values fall within standard interquartile bounds.`
        };
      }
    }
  }

  // 4. Question: Correlation
  if (
    lowerQuery.includes('correlation') || 
    lowerQuery.includes('relate') || 
    lowerQuery.includes('relationship') ||
    lowerQuery.includes('link')
  ) {
    if (numericCols.length >= 2) {
      const colA = mainNumeric;
      const colB = numericCols[1];
      const valA = rows.map(r => Number(r[colA])).filter(v => !isNaN(v));
      const valB = rows.map(r => Number(r[colB])).filter(v => !isNaN(v));
      
      if (valA.length === valB.length) {
        const corr = getCorrelation(valA, valB);
        const strength = Math.abs(corr) >= 0.7 ? "strong" : Math.abs(corr) >= 0.4 ? "moderate" : "weak";
        const direction = corr > 0 ? "positive" : "negative";
        
        let text = `Analyzing the correlation between **${colA}** and **${colB}**:\n\n`;
        text += `- Pearson Correlation Coefficient: **${corr.toFixed(3)}**\n`;
        text += `- Relationship: **${strength} ${direction} correlation**\n\n`;
        
        if (strength !== "weak") {
          text += corr > 0 
            ? `This indicates that as **${colA}** increases, **${colB}** has a clear tendency to increase. This could represent a direct driver/outcome relationship.`
            : `This indicates that as **${colA}** increases, **${colB}** tends to decrease. For example, discount rates vs margins.`;
        } else {
          text += `There appears to be no strong linear relationship between these two columns. Changes in one do not reliably predict changes in the other.`;
        }
        
        // Return first 15 data points for comparison
        const chartData = rows.slice(0, 20).map((r, i) => ({
          name: `Pt ${i + 1}`,
          [colA]: Number(r[colA]),
          [colB]: Number(r[colB])
        }));
        
        return {
          answer: text,
          chartData,
          chartConfig: {
            type: 'line',
            xAxisKey: 'name',
            yAxisKey: colA, // plot one against another or just render comparison
            title: `Correlation comparison (sample of first 20 records)`
          }
        };
      }
    }
  }

  // 5. Default/Help Response
  let helpText = `I didn't quite capture the specific question, but I can help you analyze **"${dataset.fileName}"**! Try asking me questions like:
  
- *"Which category has the highest sales?"* (performs group aggregations)
- *"What is the monthly trend of sales?"* (identifies date trends)
- *"List the outliers in revenue"* (searches for statistical anomalies)
- *"Is there a correlation between columns?"* (computes correlation indexes)

**Dataset Summary:**
- Columns: ${headers.join(', ')}
- Row count: ${rows.length}
`;
  return { answer: helpText };
}
