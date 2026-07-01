import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Bot, User, Printer, FileText, 
  TrendingUp, BarChart2, ShieldAlert, Heart, RefreshCw 
} from 'lucide-react';
import { Dataset } from '../utils/parser';
import { generateInsights, answerQuery, QueryResponse } from '../utils/insights';
import { 
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, 
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer 
} from 'recharts';

interface AIInsightsProps {
  dataset: Dataset;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  chartData?: any[];
  chartConfig?: {
    type: 'bar' | 'line' | 'pie' | 'kpi';
    xAxisKey?: string;
    yAxisKey?: string;
    title?: string;
  };
}

const COLORS = ['#06b6d4', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6'];

export default function AIInsights({ dataset }: AIInsightsProps) {
  const [activeTab, setActiveTab] = useState<'report' | 'chat'>('report');
  
  // Backend insights state
  const [backendInsights, setBackendInsights] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Q&A Chat states
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputVal, setInputVal] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchBackendInsights = async () => {
      setIsLoading(true);
      try {
        const res = await fetch('/api/insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: dataset.rows })
        });
        if (res.ok) {
          const data = await res.json();
          setBackendInsights(data.insights);
        }
      } catch (err) {
        console.error("Failed to fetch insights", err);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchBackendInsights();
  }, [dataset]);

  // Set initial bot message
  useEffect(() => {
    setMessages([
      {
        id: 'init-msg',
        sender: 'bot',
        text: `Hello! I am your Cleanlytics AI assistant. I've analyzed **"${dataset.fileName}"**.\n\nYou can ask me questions about categories, monthly trends, statistical outliers, or correlations. What would you like to explore?`
      }
    ]);
  }, [dataset]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = (textToSend?: string) => {
    const queryText = textToSend || inputVal;
    if (!queryText.trim()) return;

    const userMsgId = `user-${Date.now()}`;
    const newMessages = [
      ...messages,
      { id: userMsgId, sender: 'user' as const, text: queryText }
    ];
    setMessages(newMessages);
    setInputVal('');

    setTimeout(() => {
      const response = answerQuery(dataset, queryText);
      setMessages(prev => [
        ...prev,
        {
          id: `bot-${Date.now()}`,
          sender: 'bot',
          text: response.answer,
          chartData: response.chartData,
          chartConfig: response.chartConfig
        }
      ]);
    }, 400);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const quickQuestions = [
    "Which category is top?",
    "Show me monthly sales trend",
    "What are the outliers?",
    "Find correlations"
  ];

  const renderMessageChart = (msg: ChatMessage) => {
    if (!msg.chartData || !msg.chartConfig) return null;
    const { type, xAxisKey, yAxisKey, title } = msg.chartConfig;

    return (
      <div className="mt-4 p-3 rounded-lg border border-gray-800 bg-zinc-950/50 h-[180px] w-full text-xs">
        <p className="text-[10px] font-semibold text-gray-400 mb-2 truncate">{title || 'Analysis Chart'}</p>
        <ResponsiveContainer width="100%" height="90%">
          {type === 'bar' && xAxisKey && yAxisKey ? (
            <BarChart data={msg.chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" />
              <XAxis dataKey={xAxisKey} stroke="#6b7280" fontSize={8} tickLine={false} />
              <YAxis stroke="#6b7280" fontSize={8} tickLine={false} />
              <Tooltip 
                contentStyle={{ background: '#09090b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                labelStyle={{ fontSize: '8px', color: '#9ca3af' }}
                itemStyle={{ fontSize: '8px', color: '#fff' }}
              />
              <Bar dataKey={yAxisKey} fill="#06b6d4" radius={[2, 2, 0, 0]}>
                {msg.chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          ) : type === 'line' && xAxisKey && yAxisKey ? (
            <LineChart data={msg.chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" />
              <XAxis dataKey={xAxisKey} stroke="#6b7280" fontSize={8} tickLine={false} />
              <YAxis stroke="#6b7280" fontSize={8} tickLine={false} />
              <Tooltip 
                contentStyle={{ background: '#09090b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                labelStyle={{ fontSize: '8px', color: '#9ca3af' }}
                itemStyle={{ fontSize: '8px', color: '#fff' }}
              />
              <Line type="monotone" dataKey={yAxisKey} stroke="#6366f1" strokeWidth={1.5} dot={{ r: 1.5 }} />
            </LineChart>
          ) : (
            <PieChart>
              <Pie
                data={msg.chartData}
                cx="50%"
                cy="50%"
                innerRadius={25}
                outerRadius={40}
                dataKey="value"
              >
                {msg.chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip 
                contentStyle={{ background: '#09090b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                itemStyle={{ fontSize: '8px', color: '#fff' }}
              />
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in print-area">
      {/* Header Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-800 pb-3 no-print">
        <div className="flex gap-2 bg-zinc-950/60 p-1 rounded-xl border border-gray-800/80">
          <button
            onClick={() => setActiveTab('report')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
              activeTab === 'report' 
                ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <FileText className="h-4 w-4" />
            Automated Report
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
              activeTab === 'chat' 
                ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            Cleanlytics AI Q&A
          </button>
        </div>

        {activeTab === 'report' && (
          <button
            onClick={handlePrint}
            className="px-4 py-2 rounded-lg bg-zinc-900 border border-gray-800 text-gray-300 hover:text-white hover:bg-zinc-800 text-xs flex items-center gap-2 transition"
          >
            <Printer className="h-4 w-4" />
            Print Report (PDF)
          </button>
        )}
      </div>

      {/* 1. Automated Report View */}
      {activeTab === 'report' && (
        <div className="space-y-6">
          {isLoading ? (
             <div className="flex flex-col items-center justify-center py-20 text-cyan-400">
               <RefreshCw className="h-8 w-8 animate-spin mb-4" />
               <p className="font-semibold text-sm">Generating AI Insights...</p>
             </div>
          ) : backendInsights ? (
            <>
              {/* Executive Summary Card */}
              <div className="glass-panel p-6 rounded-xl space-y-3 relative overflow-hidden">
                <div className="absolute top-0 right-0 h-24 w-24 bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 rounded-full blur-2xl"></div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-emerald-400" />
                  Executive Business Summary
                </h3>
                <p className="text-sm text-gray-300 leading-relaxed max-w-[800px]">
                  Based on the comprehensive AI analysis, the dataset contains {backendInsights.summary?.num_rows} records across {backendInsights.summary?.num_columns} features. 
                  The overall Data Quality Score is evaluated at {backendInsights.data_quality_score}/100.
                </p>
              </div>

              {/* Key Metric cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="glass-panel p-4 rounded-xl border border-gray-800/60 bg-zinc-900/10">
                  <p className="text-xs text-gray-500 font-semibold">Data Quality Score</p>
                  <p className="text-xl font-bold text-white mt-1 font-mono">{backendInsights.data_quality_score}/100</p>
                  <p className="text-[10px] text-gray-400 mt-1">Based on completeness & anomalies</p>
                </div>
                <div className="glass-panel p-4 rounded-xl border border-gray-800/60 bg-zinc-900/10">
                  <p className="text-xs text-gray-500 font-semibold">Total Cells Analyzed</p>
                  <p className="text-xl font-bold text-white mt-1 font-mono">{(backendInsights.summary?.num_rows * backendInsights.summary?.num_columns).toLocaleString()}</p>
                  <p className="text-[10px] text-gray-400 mt-1">Total data points processed</p>
                </div>
                <div className="glass-panel p-4 rounded-xl border border-gray-800/60 bg-zinc-900/10">
                  <p className="text-xs text-gray-500 font-semibold">Recommendations</p>
                  <p className="text-xl font-bold text-white mt-1 font-mono">{backendInsights.recommendations?.length || 0}</p>
                  <p className="text-[10px] text-gray-400 mt-1">Actionable insights found</p>
                </div>
              </div>

              {/* Detailed Recommendations list */}
              <div className="glass-panel p-5 rounded-xl space-y-4">
                <h4 className="text-sm font-semibold text-white border-b border-gray-800 pb-3">AI Recommendations</h4>
                
                {!backendInsights.recommendations || backendInsights.recommendations.length === 0 ? (
                  <p className="text-xs text-gray-500 italic text-center py-8">
                    Your dataset looks pristine! No critical actions recommended.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {backendInsights.recommendations.map((rec: string, idx: number) => {
                      return (
                        <div key={idx} className="p-4 border border-gray-800/80 bg-zinc-950/20 rounded-xl space-y-2 flex flex-col justify-between hover:border-gray-700/80 transition duration-200">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-amber-950/40 text-amber-500 border border-amber-900/30">
                                AI Suggestion
                              </span>
                              <ShieldAlert className="h-4.5 w-4.5 text-amber-500" />
                            </div>
                            <h5 className="text-xs font-bold text-gray-200">Recommendation #{idx + 1}</h5>
                            <p className="text-[11px] text-gray-400 leading-normal">{rec}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              
              {/* Heatmap & Anomalies */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="glass-panel p-5 rounded-xl space-y-4">
                   <h4 className="text-sm font-semibold text-white border-b border-gray-800 pb-3">Correlation Heatmap</h4>
                   <div className="text-[10px] text-gray-400 overflow-auto max-h-[300px]">
                      {backendInsights.correlation_matrix && Object.keys(backendInsights.correlation_matrix).length > 0 ? (
                         <table className="w-full text-left border-collapse">
                           <thead>
                             <tr>
                               <th className="p-2 border border-gray-800"></th>
                               {Object.keys(backendInsights.correlation_matrix).map(col => (
                                 <th key={col} className="p-2 border border-gray-800 truncate max-w-[80px]" title={col}>{col}</th>
                               ))}
                             </tr>
                           </thead>
                           <tbody>
                             {Object.entries(backendInsights.correlation_matrix).map(([rowCol, values]: [string, any]) => (
                               <tr key={rowCol}>
                                 <td className="p-2 border border-gray-800 font-semibold truncate max-w-[80px]" title={rowCol}>{rowCol}</td>
                                 {Object.values(values).map((val: any, idx) => {
                                    const numVal = val === null ? 0 : Number(val);
                                    const intensity = Math.abs(numVal);
                                    const bgColor = numVal > 0 ? `rgba(16, 185, 129, ${intensity * 0.8})` : numVal < 0 ? `rgba(239, 68, 68, ${intensity * 0.8})` : 'transparent';
                                    return (
                                      <td key={idx} className="p-2 border border-gray-800 text-center font-mono" style={{ backgroundColor: bgColor }}>
                                        {val !== null ? numVal.toFixed(2) : '-'}
                                      </td>
                                    );
                                 })}
                               </tr>
                             ))}
                           </tbody>
                         </table>
                      ) : (
                         <p className="italic text-center py-4">No significant numeric correlations found.</p>
                      )}
                   </div>
                </div>

                <div className="glass-panel p-5 rounded-xl space-y-4">
                   <h4 className="text-sm font-semibold text-white border-b border-gray-800 pb-3">Anomaly Highlights (Outliers)</h4>
                   <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                     {backendInsights.outliers && Object.keys(backendInsights.outliers).length > 0 ? (
                       Object.entries(backendInsights.outliers).map(([col, count]: [string, any]) => (
                         count > 0 && (
                           <div key={col} className="flex items-center justify-between p-3 border border-gray-800 rounded bg-zinc-900/30">
                             <span className="text-xs font-semibold text-gray-300">{col}</span>
                             <div className="flex items-center gap-2">
                               <span className="text-xs font-mono text-red-400 font-bold">{count}</span>
                               <span className="text-[10px] text-gray-500 uppercase tracking-wider">Outliers</span>
                             </div>
                           </div>
                         )
                       ))
                     ) : (
                       <p className="text-[10px] italic text-gray-500 text-center py-4">No statistical outliers detected.</p>
                     )}
                   </div>
                </div>
              </div>
            </>
          ) : (
             <div className="text-center py-10 text-red-400">Failed to load insights.</div>
          )}
        </div>
      )}

      {/* 2. Interactive AI Chat Q&A View */}
      {activeTab === 'chat' && (
        <div className="glass-panel rounded-xl overflow-hidden border border-gray-800 h-[550px] flex flex-col no-print">
          {/* Chat Window Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-zinc-950/20">
            {messages.map(msg => {
              const isBot = msg.sender === 'bot';
              return (
                <div 
                  key={msg.id} 
                  className={`flex gap-3 max-w-[85%] ${
                    isBot ? 'self-start' : 'self-end flex-row-reverse ml-auto'
                  } animate-fade-in`}
                >
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center border shrink-0 ${
                    isBot 
                      ? 'bg-cyan-950/40 border-cyan-800/30 text-cyan-400' 
                      : 'bg-emerald-950/40 border-emerald-800/30 text-emerald-400'
                  }`}>
                    {isBot ? <Bot className="h-4.5 w-4.5" /> : <User className="h-4.5 w-4.5" />}
                  </div>
                  
                  <div className={`p-3.5 rounded-xl ${
                    isBot 
                      ? 'bg-zinc-900/60 text-gray-200 border border-gray-800/80' 
                      : 'bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 text-gray-100 border border-cyan-500/20'
                  }`}>
                    <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                    {renderMessageChart(msg)}
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Quick Recommendations */}
          {messages.length === 1 && (
            <div className="px-4 py-2 border-t border-gray-900 flex flex-wrap gap-2 bg-zinc-900/10">
              {quickQuestions.map(q => (
                <button
                  key={q}
                  onClick={() => handleSendMessage(q)}
                  className="px-2.5 py-1 text-[10px] rounded-full border border-gray-800 hover:border-cyan-500/40 hover:bg-cyan-950/20 text-gray-400 hover:text-cyan-400 transition"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Chat Input Bar */}
          <div className="p-3.5 border-t border-gray-900 flex gap-2 bg-zinc-900/20">
            <input 
              type="text" 
              placeholder="Ask Cleanlytics AI... (e.g. Which region is top? What is the trend?)"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={handleKeyPress}
              className="flex-1 glass-input text-xs"
            />
            <button
              onClick={() => handleSendMessage()}
              className="px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white font-semibold hover:from-cyan-400 hover:to-emerald-400 shadow shadow-cyan-500/10 flex items-center justify-center gap-1.5 transition text-xs"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
