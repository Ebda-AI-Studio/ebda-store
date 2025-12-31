'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';

// Demo analytics data
const monthlyRevenue = [
  { month: 'Jan', revenue: 12500 },
  { month: 'Feb', revenue: 15800 },
  { month: 'Mar', revenue: 14200 },
  { month: 'Apr', revenue: 18900 },
  { month: 'May', revenue: 22100 },
  { month: 'Jun', revenue: 19800 },
  { month: 'Jul', revenue: 24500 },
  { month: 'Aug', revenue: 28300 },
  { month: 'Sep', revenue: 25600 },
  { month: 'Oct', revenue: 31200 },
  { month: 'Nov', revenue: 35800 },
  { month: 'Dec', revenue: 42100 },
];

const topCategories = [
  { name: 'Electronics', sales: 156, percentage: 42 },
  { name: 'Wearables', sales: 98, percentage: 26 },
  { name: 'Accessories', sales: 87, percentage: 23 },
  { name: 'Other', sales: 32, percentage: 9 },
];

const trafficSources = [
  { source: 'Direct', visits: 12500, percentage: 35 },
  { source: 'Organic Search', visits: 9800, percentage: 28 },
  { source: 'Social Media', visits: 7200, percentage: 20 },
  { source: 'Referrals', visits: 4100, percentage: 12 },
  { source: 'Email', visits: 1800, percentage: 5 },
];

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(amount);
}

export default function AnalyticsPage() {
  const totalRevenue = monthlyRevenue.reduce((sum, m) => sum + m.revenue, 0);
  const maxRevenue = Math.max(...monthlyRevenue.map(m => m.revenue));

  return (
    <AdminLayout title="Analytics" subtitle="Track your store performance">
      {/* Overview Stats */}
      <div className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Revenue (YTD)</CardDescription>
            <CardTitle className="text-2xl text-primary">{formatCurrency(totalRevenue)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-green-600 font-medium">+32.5% from last year</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Average Order Value</CardDescription>
            <CardTitle className="text-2xl">$127.50</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-green-600 font-medium">+5.2% from last month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Conversion Rate</CardDescription>
            <CardTitle className="text-2xl">3.24%</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-red-600 font-medium">-0.3% from last month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Visitors</CardDescription>
            <CardTitle className="text-2xl">35,400</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-green-600 font-medium">+18.7% from last month</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Section */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Revenue Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Monthly Revenue</CardTitle>
            <CardDescription>Revenue breakdown for the current year</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <div className="flex h-full items-end gap-2">
                {monthlyRevenue.map(item => (
                  <div key={item.month} className="flex-1 flex flex-col items-center gap-2">
                    <div
                      className="w-full bg-gradient-to-t from-primary to-orange-400 rounded-t transition-all hover:from-primary/80 hover:to-orange-300"
                      style={{ height: `${(item.revenue / maxRevenue) * 100}%` }}
                      title={formatCurrency(item.revenue)}
                    />
                    <span className="text-xs text-gray-500">{item.month}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Top Categories */}
        <Card>
          <CardHeader>
            <CardTitle>Sales by Category</CardTitle>
            <CardDescription>Product category performance</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {topCategories.map(category => (
                <div key={category.name}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-700">{category.name}</span>
                    <span className="text-sm text-gray-500">
                      {category.sales} sales ({category.percentage}%)
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-gray-100">
                    <div
                      className="h-2 rounded-full bg-primary transition-all"
                      style={{ width: `${category.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Traffic Sources */}
        <Card>
          <CardHeader>
            <CardTitle>Traffic Sources</CardTitle>
            <CardDescription>Where your visitors come from</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {trafficSources.map(source => (
                <div key={source.source} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                      <svg
                        className="h-4 w-4 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                        />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{source.source}</p>
                      <p className="text-xs text-gray-500">
                        {source.visits.toLocaleString()} visits
                      </p>
                    </div>
                  </div>
                  <span className="text-sm font-medium text-gray-600">{source.percentage}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest events in your store</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              {
                icon: '🛒',
                text: 'New order #ORD-156 from John Doe',
                time: '5 minutes ago',
                color: 'bg-blue-100',
              },
              {
                icon: '👤',
                text: 'New customer registered: alice@example.com',
                time: '12 minutes ago',
                color: 'bg-green-100',
              },
              {
                icon: '📦',
                text: 'Order #ORD-154 shipped to Jane Smith',
                time: '1 hour ago',
                color: 'bg-purple-100',
              },
              {
                icon: '⭐',
                text: 'New 5-star review on Premium Headphones',
                time: '2 hours ago',
                color: 'bg-yellow-100',
              },
              {
                icon: '💰',
                text: 'Payment received for order #ORD-153',
                time: '3 hours ago',
                color: 'bg-primary/10',
              },
            ].map((activity, index) => (
              <div key={index} className="flex items-center gap-4">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full ${activity.color}`}
                >
                  <span className="text-lg">{activity.icon}</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-gray-900">{activity.text}</p>
                  <p className="text-xs text-gray-500">{activity.time}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
