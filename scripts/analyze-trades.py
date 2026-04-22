#!/usr/bin/env python3
"""
Comprehensive trading analysis: swaps, slippage, profitability, errors.
Analyzes all execution reports and portfolio performance.
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import statistics

def load_json_file(path):
    """Safely load JSON file."""
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except:
        return None

def analyze_portfolio_reports():
    """Analyze all portfolio reports for P&L and slippage trends."""
    report_dir = Path("token portfolio/BSC/REPORT")
    daily_dir = report_dir / "daily"
    
    print("\n" + "="*80)
    print("PORTFOLIO ANALYSIS - Daily Reports")
    print("="*80)
    
    if not daily_dir.exists():
        print(f"Directory not found: {daily_dir}")
        return
    
    daily_reports = sorted(daily_dir.glob("*.json"), reverse=True)
    
    if not daily_reports:
        print("No daily reports found")
        return
    
    print(f"\nFound {len(daily_reports)} daily reports")
    
    # Analyze latest report
    latest = load_json_file(daily_reports[0])
    if latest:
        print(f"\n📊 LATEST REPORT: {daily_reports[0].name}")
        portfolio = latest.get('portfolio', {})
        print(f"   Start Value: ${portfolio.get('startValueUSD', 0):.2f}")
        print(f"   End Value: ${portfolio.get('endValueUSD', 0):.2f}")
        print(f"   Daily P&L: ${portfolio.get('dailyPnlUSD', 0):.2f} ({portfolio.get('dailyPnlPct', 0):.2f}%)")
        print(f"   High Value: ${portfolio.get('highValueUSD', 0):.2f}")
        print(f"   Low Value: ${portfolio.get('lowValueUSD', 0):.2f}")
        
        tokens = latest.get('tokenTrends', [])
        if tokens:
            print(f"\n   📈 Token Positions ({len(tokens)} tokens):")
            for t in tokens[:5]:
                print(f"      {t.get('symbol', 'N/A')}: {t.get('pnlTrend', 'N/A')} "
                      f"(P&L: {t.get('pnlEnd', 0):.2f} USD, Price Change: {t.get('priceTrend', 0):.2f}%)")
    
    # Trend analysis
    pnl_values = []
    pnl_pcts = []
    
    for report_file in daily_reports[:5]:  # Last 5 days
        report = load_json_file(report_file)
        if report:
            portfolio = report.get('portfolio', {})
            pnl_usd = portfolio.get('dailyPnlUSD', 0)
            pnl_pct = portfolio.get('dailyPnlPct', 0)
            pnl_values.append(pnl_usd)
            pnl_pcts.append(pnl_pct)
            date = report.get('date', 'Unknown')
            print(f"\n   {date}: ${pnl_usd:.2f} ({pnl_pct:.2f}%)")
    
    if len(pnl_values) > 1:
        avg_pnl = statistics.mean(pnl_values)
        print(f"\n   Average Daily P&L: ${avg_pnl:.2f}")
        print(f"   Trend: {'NEGATIVE ⚠️' if avg_pnl < 0 else 'POSITIVE ✅'}")

def analyze_trade_logs():
    """Analyze production logs for trade execution patterns."""
    print("\n" + "="*80)
    print("TRADE EXECUTION ANALYSIS - Production Logs")
    print("="*80)
    
    log_file = Path("data/logs/production.log")
    if not log_file.exists():
        print(f"Log file not found: {log_file}")
        return
    
    with open(log_file, 'r') as f:
        lines = f.readlines()
    
    print(f"\nTotal log lines: {len(lines)}")
    print(f"Log file size: {log_file.stat().st_size / 1024:.2f} KB")
    
    # Count decision types
    decisions = defaultdict(int)
    errors = []
    swaps = []
    executions = defaultdict(int)
    
    for line in lines:
        if 'decision=' in line:
            for action in ['buy', 'sell', 'hold']:
                if f'decision={action}' in line:
                    decisions[action] += 1
                    break
        
        if 'error' in line.lower() or 'fail' in line.lower():
            errors.append(line.strip())
        
        if 'swap' in line.lower() or 'execute' in line.lower():
            swaps.append(line.strip())
        
        if 'execution_mode=' in line:
            for mode in ['sent', 'failed', 'dry']:
                if f'execution_mode={mode}' in line:
                    executions[mode] += 1
                    break
    
    print(f"\n📊 Decision Distribution:")
    for action, count in decisions.items():
        print(f"   {action.upper()}: {count}")
    
    total_decisions = sum(decisions.values())
    if total_decisions > 0:
        hold_ratio = (decisions['hold'] / total_decisions) * 100
        print(f"\n   Hold Ratio: {hold_ratio:.1f}% (⚠️ Very High if > 80%)")
    
    if executions:
        print(f"\n📤 Execution Status:")
        for mode, count in executions.items():
            print(f"   {mode.upper()}: {count}")
    
    if errors:
        print(f"\n⚠️ Errors Found ({len(errors)} total):")
        for err in errors[-5:]:  # Last 5 errors
            print(f"   {err}")
    
    if swaps:
        print(f"\n💱 Swap/Execute mentions ({len(swaps)} total):")
        for swap in swaps[-3:]:  # Last 3
            print(f"   {swap[:120]}...")

def analyze_slippage_metrics():
    """Analyze slippage and price impact from execution reports."""
    print("\n" + "="*80)
    print("SLIPPAGE & PRICE IMPACT ANALYSIS")
    print("="*80)
    
    report_dir = Path("token portfolio/BSC/REPORT")
    reports = sorted(report_dir.glob("*.json"), reverse=True)[:10]
    
    slippage_values = []
    impact_values = []
    
    for report_file in reports:
        report = load_json_file(report_file)
        if isinstance(report, dict) and 'raw' in report:
            raw = report.get('raw', {})
            
            # Extract slippage if available
            if 'slippageEstPct' in raw:
                try:
                    slippage_values.append(float(raw['slippageEstPct']))
                except:
                    pass
            
            # Extract price impact
            if 'priceImpactPercent' in raw:
                try:
                    impact_values.append(float(raw['priceImpactPercent']))
                except:
                    pass
    
    if slippage_values:
        print(f"\n📊 Slippage Metrics:")
        print(f"   Min: {min(slippage_values):.4f}%")
        print(f"   Max: {max(slippage_values):.4f}%")
        print(f"   Avg: {statistics.mean(slippage_values):.4f}%")
        print(f"   Median: {statistics.median(slippage_values):.4f}%")
        print(f"   Count: {len(slippage_values)}")
    
    if impact_values:
        print(f"\n💹 Price Impact Metrics:")
        print(f"   Min: {min(impact_values):.4f}%")
        print(f"   Max: {max(impact_values):.4f}%")
        print(f"   Avg: {statistics.mean(impact_values):.4f}%")
        print(f"   Count: {len(impact_values)}")
    
    print(f"\n⚠️ TARGET: Slippage < 0.2%, Price Impact < 0.3%")

def check_system_resources():
    """Check current system resource usage."""
    print("\n" + "="*80)
    print("SYSTEM RESOURCES ANALYSIS")
    print("="*80)
    
    # Check processes
    os.system("echo '\\n📊 Node.js Processes:' && pgrep -f 'tsx|node' | wc -l && ps aux | grep -E 'tsx|node' | grep -v grep | head -3")
    
    # Check port
    os.system("echo '\\n🔌 Port 8787 Status:' && lsof -i :8787 | grep -v COMMAND || echo 'Port 8787 is FREE'")
    
    # Check disk
    os.system("echo '\\n💾 Disk Usage (Current Dir):' && du -sh . 2>/dev/null")
    
    # Check free memory
    os.system("echo '\\n💾 System Memory:' && free -h | grep Mem")
    
    # Check CPU load
    os.system("echo '\\n🔥 CPU Load:' && uptime | awk -F'load average:' '{print $2}'")

def identify_issues():
    """Identify critical issues and create recommendations."""
    print("\n" + "="*80)
    print("CRITICAL ISSUES & RECOMMENDATIONS")
    print("="*80)
    
    issues = []
    
    # Check portfolio status
    daily_dir = Path("token portfolio/BSC/REPORT/daily")
    if daily_dir.exists():
        latest = sorted(daily_dir.glob("*.json"), reverse=True)
        if latest:
            report = load_json_file(latest[0])
            if report:
                pnl = report.get('portfolio', {}).get('dailyPnlPct', 0)
                if pnl < -50:
                    issues.append({
                        'severity': 'CRITICAL',
                        'issue': 'Portfolio losing >50% daily',
                        'recommendation': 'STOP trading immediately, analyze baseline strategy'
                    })
                elif pnl < 0:
                    issues.append({
                        'severity': 'HIGH',
                        'issue': 'Negative daily P&L',
                        'recommendation': 'Review slippage, price impact, and strategy confidence'
                    })
    
    # Check decision distribution
    log_file = Path("data/logs/production.log")
    if log_file.exists():
        with open(log_file, 'r') as f:
            content = f.read()
            if content.count('decision=hold') > content.count('decision=buy') * 3:
                issues.append({
                    'severity': 'HIGH',
                    'issue': 'Too many HOLD decisions (>75% of trades)',
                    'recommendation': 'Lower confidence thresholds, adjust baseline strategy'
                })
    
    # Print issues
    if issues:
        for issue in issues:
            icon = '🔴' if issue['severity'] == 'CRITICAL' else '🟠'
            print(f"\n{icon} [{issue['severity']}] {issue['issue']}")
            print(f"   → {issue['recommendation']}")
    else:
        print("\n✅ No critical issues detected")

if __name__ == "__main__":
    print("\n🤖 OKX TRADING BOT - COMPREHENSIVE ANALYSIS")
    print(f"Generated: {datetime.now().isoformat()}\n")
    
    analyze_portfolio_reports()
    analyze_trade_logs()
    analyze_slippage_metrics()
    check_system_resources()
    identify_issues()
    
    print("\n" + "="*80)
    print("Analysis Complete")
    print("="*80 + "\n")
