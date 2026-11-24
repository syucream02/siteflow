import { exactFields, need } from './contract.mjs';
import { validateStoragePolicy } from './linux-storage.mjs';

const MOUNT = 'srv-siteflow\\x2dmysql.mount';
// Docker socketを扱うroot workerは実質root相当。NoNewPrivileges等だけでは隔離できない。
// MemoryMax/SwapMaxもDocker daemonが作るコンテナには波及しない。コンテナ側で別制限する。
// unitを生成/配置しない。固定wrapperも未実装。通常の再起動と新しい版への更新を分ける。
export function createSystemdPlan(storagePolicy) {
  validateStoragePolicy(storagePolicy);
  return {
    mode: 'local-plan', executionAllowed: false,
    service: {
      type: 'oneshot', remainAfterExit: false, restart: 'no', user: 'root', umask: '0077',
      requires: [MOUNT, 'docker.service'], wants: ['network-online.target'],
      after: [MOUNT, 'docker.service', 'network-online.target', 'siteflow-mysql.service'], bindsTo: [MOUNT],
      requiresMountsFor: [storagePolicy.mount], readWritePaths: [storagePolicy.stateDirectory],
      // Nginxへの書込範囲は専用wrapperの別設計/承認まで開けない。
      protectSystem: 'strict', protectHome: true, privateTmp: true, noNewPrivileges: true,
      memoryMaxMiB: 128, memorySwapMax: 0, limitCore: 0, tasksMax: 64,
      timeoutStartSec: 240, timeoutStopSec: 45, killMode: 'control-group',
      standardOutput: 'null', standardError: 'null', commandArguments: [], environmentSecrets: [],
    },
    timer: { onBootSec: 300, onUnitInactiveSec: 300, randomizedDelaySec: 15, persistent: false },
    initial: { enabled: false, paused: true },
    prerequisites: ['verify_mount_identity', 'read_incident_and_lock', 'verify_stop_switch', 'check_mysql_without_starting_it', 'recover_stable_before_polling'],
    stopPlan: ['append_stop_request_without_deploy_lock', 'verify_stop_recorded_not_worker_stopped', 'disable_stop_timer', 'request_worker_abort', 'inspect_inflight_and_confirm_previous_nextjs'],
    pendingChecks: ['installed_systemd_version', 'fixed_privileged_wrapper', 'nginx_write_scope', 'sanitized_result_logging', 'reboot_and_signal_integration', 'docker_daemon_jobs_survive_worker_exit'],
  };
}
export function assessSystemdStart(plan, observed, storagePolicy) {
  // 既知の安全な計画全体と照合。write scope等の未検査項目を後から差し替えない。
  need(JSON.stringify(plan) === JSON.stringify(createSystemdPlan(storagePolicy)), 'SYSTEMD_PLAN_CHANGED');
  exactFields(observed, ['mountReady', 'dockerReady', 'networkReady', 'mysqlHealthy', 'clockSynchronized', 'paused', 'incident', 'residualLock', 'serviceActive', 'lockHeld', 'dependencies'], 'INVALID_SYSTEMD_OBSERVATION');
  need(plan?.mode === 'local-plan' && plan.executionAllowed === false && plan.service?.type === 'oneshot' &&
    plan.service.remainAfterExit === false && plan.service.restart === 'no' && plan.service.killMode === 'control-group' &&
    plan.timer?.onUnitInactiveSec === 300 && plan.timer.persistent === false && plan.timer.onBootSec === 300 &&
    plan.service.user === 'root' && plan.service.umask === '0077' && plan.service.protectSystem === 'strict' &&
    plan.service.protectHome === true && plan.service.privateTmp === true && plan.service.noNewPrivileges === true &&
    plan.service.memoryMaxMiB === 128 && plan.service.memorySwapMax === 0 && plan.service.limitCore === 0 && plan.service.tasksMax === 64 &&
    plan.service.timeoutStartSec === 240 && plan.service.timeoutStopSec === 45 &&
    plan.service.standardOutput === 'null' && plan.service.standardError === 'null' &&
    Array.isArray(plan.service.commandArguments) && plan.service.commandArguments.length === 0 &&
    Array.isArray(plan.service.environmentSecrets) && plan.service.environmentSecrets.length === 0, 'UNSAFE_SYSTEMD_PLAN');
  need(Array.isArray(observed.dependencies) && [MOUNT, 'docker.service', 'network-online.target', 'siteflow-mysql.service'].every(d =>
    plan.service.after.includes(d) && observed.dependencies.includes(d)) && plan.service.requires.includes(MOUNT) && plan.service.bindsTo.includes(MOUNT), 'DEPENDENCY_ORDER_UNVERIFIED');
  need(['mountReady', 'dockerReady', 'networkReady', 'mysqlHealthy', 'clockSynchronized'].every(k => observed[k] === true) &&
    ['paused', 'incident', 'residualLock', 'serviceActive', 'lockHeld'].every(k => observed[k] === false), 'START_BLOCKED');
  return { status: 'mock_start_prerequisites_consistent', executionAllowed: false };
}
