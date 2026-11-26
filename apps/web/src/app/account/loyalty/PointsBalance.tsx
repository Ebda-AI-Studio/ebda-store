'use client';

/**
 * The shopper's points balance (#631). A refund can take back points the shopper already spent, leaving a debt: the
 * balance is shown as 0 and the debt as its own sentence ("points owed"), never as a bare negative number (a minus sign
 * also lands on the wrong side in Arabic). The number sits in <bdi> so RTL text never reorders it.
 */
export function PointsBalance({
  points,
  language,
  localize,
}: {
  points: number;
  language: 'en' | 'ar' | string;
  localize: (s: string) => string;
}) {
  const ar = language === 'ar';
  const n = (v: number) => localize(v.toLocaleString('en-US'));
  const owed = points < 0 ? -points : 0;
  return (
    <>
      <p className="mt-1 text-5xl font-bold text-primary">{n(Math.max(0, points))}</p>
      <p className="mt-1 text-sm text-muted-foreground">{ar ? 'نقط' : 'points'}</p>
      {owed > 0 && (
        <p data-testid="points-owed" className="mt-2 max-w-sm text-sm text-foreground">
          {ar ? (
            <>
              عليك <bdi>{n(owed)}</bdi> نقطة، اتصرفت قبل ما الطلب اللي كسبها يترجّع. هتتخصم من النقط
              اللي هتكسبها بعد كده.
            </>
          ) : (
            <>
              Points owed: <bdi>{n(owed)}</bdi>. They were spent before the order that earned them
              was refunded, so they come off the next points you earn.
            </>
          )}
        </p>
      )}
    </>
  );
}
