-- Proportional delay when per-token request rate exceeds sustained limit.
-- core.sleep() yields the coroutine without blocking HAProxy threads.

local SUSTAINED = 60   -- req/60s: no delay at or below this rate
local BURST     = 30   -- extra requests in burst zone (delayed, not denied)
local SCALE     = 2    -- seconds of delay at the burst boundary (rate == SUSTAINED + BURST)
local MAX_DELAY = 10   -- hard cap on delay in seconds

core.register_action("throttle", {"http-req"}, function(txn)
    local rate = txn:get_var("txn.current_rate")
    if rate == nil then return end
    rate = tonumber(rate) or 0

    if rate <= SUSTAINED then return end

    local delay
    if rate <= SUSTAINED + BURST then
        -- Burst zone: linear ramp from 0 to SCALE
        delay = (rate - SUSTAINED) / BURST * SCALE
    else
        -- Above burst: keeps climbing past SCALE
        delay = SCALE + (rate - SUSTAINED - BURST) / SUSTAINED * SCALE
    end

    delay = math.min(delay, MAX_DELAY)
    if delay >= 0.05 then
        txn:set_var("txn.throttle_delay_ms", math.floor(delay * 1000))
        core.sleep(delay)
    end
end)
