/*
	Licensed under the Apache License, Version 2.0 (the "License");
	you may not use this file except in compliance with the License.
	You may obtain a copy of the License at

		http://www.apache.org/licenses/LICENSE-2.0

	Unless required by applicable law or agreed to in writing, software
	distributed under the License is distributed on an "AS IS" BASIS,
	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	See the License for the specific language governing permissions and
	limitations under the License.

	Copyright (c) 2024 Siddharth Purohit, CubePilot Global Pty Ltd.
*/

import * as path from 'path';
import * as vscode from 'vscode';
import { apLog } from './apLog';
import { ProgramUtils } from './apProgramUtils';
import { targetToBin } from './apBuildConfig';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { APTaskProvider } from './taskProvider';

export interface APLaunchDefinition extends vscode.DebugConfiguration {
	/**
	 * Type of launch (must be 'apLaunch')
	 */
	type: string;
	/**
	 * Configuration name
	 */
	configure: string;
	/**
	 * Target to build
	 */
	target: string;
	/**
	 * Name of the launch
	 */
	name: string;
	/**
	 * Waf file path
	 */
	waffile?: string;
	/**
	 * sim_vehicle.py command arguments for SITL builds
	 */
	simVehicleCommand?: string,
	/**
	 * is it a SITL build
	 */
	isSITL?: boolean;
	/**
	 * MCU class (e.g., 'stm32f4')
	 */
	mcuClass?: string;
	/**
	 * MCU name (e.g., 'STM32F427VI')
	 */
	mcuName?: string;
	/**
	 * Preferred debugger type ('openocd' or 'jlink')
	 */
	preferredDebugger?: 'openocd' | 'jlink';

}

export class APLaunchConfigurationProvider implements vscode.DebugConfigurationProvider {
	private static log = new apLog('APLaunchConfigurationProvider');
	private tmuxSessionName: string | undefined;
	private debugSessionTerminal: vscode.Terminal | undefined;
	private static openOCDTargets: string[] = [];
	private static jLinkTargets: string[] = [];

	constructor() {
		// Register a debug session termination listener
		vscode.debug.onDidTerminateDebugSession(this.handleDebugSessionTermination.bind(this));
		// create a static list of STM32 targets for OpenOCD and JLink
		APLaunchConfigurationProvider.getOpenOCDSTM32TargetsList().then(targets => {
			APLaunchConfigurationProvider.openOCDTargets = targets;
			APLaunchConfigurationProvider.log.log(`OpenOCD Number STM32 targets: ${targets.length}`);
		});
		APLaunchConfigurationProvider.getJLinkSTM32TargetsList().then(targets => {
			APLaunchConfigurationProvider.jLinkTargets = targets;
			APLaunchConfigurationProvider.log.log(`JLink Number STM32 targets: ${targets.length}`);
		});
	}

	/**
	 * Gets a list of STM32 target configuration files available in OpenOCD
	 * @returns A promise that resolves to an array of STM32 target names, or undefined if OpenOCD is not available
	 */
	public static async getOpenOCDSTM32TargetsList(): Promise<string[]> {
		try {
			// Find OpenOCD installation
			const openOCD = await ProgramUtils.findOpenOCD();
			if (!openOCD.available || !openOCD.path) {
				APLaunchConfigurationProvider.log.log('OpenOCD not available, cannot fetch STM32 targets');
				return [];
			}

			// Calculate the path to OpenOCD scripts directory
			const openOCDDir = path.dirname(openOCD.path);
			let scriptsDir = path.join(openOCDDir, '..', 'share', 'openocd', 'scripts', 'target');
			const alternativeScriptsDir = path.join(openOCDDir, '..', 'scripts', 'target');

			// Check if the directory exists
			if (!fs.existsSync(scriptsDir)) {
				APLaunchConfigurationProvider.log.log(`OpenOCD scripts directory not found at: ${scriptsDir}`);
				// Attempt to find the directory at openOCD.path../scripts/target
				if (fs.existsSync(alternativeScriptsDir)) {
					APLaunchConfigurationProvider.log.log(`Found OpenOCD scripts directory at: ${alternativeScriptsDir}`);
					scriptsDir = alternativeScriptsDir;
				} else {
					APLaunchConfigurationProvider.log.log(`OpenOCD scripts directory not found at: ${alternativeScriptsDir}`);
					return [];
				}
			}

			// Find all STM32 target configuration files
			const targetFiles = fs.readdirSync(scriptsDir)
				.filter(file => file.startsWith('stm32') && file.endsWith('.cfg'))
				.map(file => path.basename(file, '.cfg'));

			APLaunchConfigurationProvider.log.log(`Found ${targetFiles.length} STM32 targets in OpenOCD scripts directory`);
			return targetFiles;
		} catch (error) {
			APLaunchConfigurationProvider.log.log(`Error getting STM32 targets: ${error}`);
			return [];
		}
	}

	/**
	 * Gets a list of STM32 targets available in JLink
	 * @returns A promise that resolves to an array of STM32 device names available in JLink
	 */
	public static async getJLinkSTM32TargetsList(): Promise<string[]> {
		try {
			// Find JLink installation
			const jLink = await ProgramUtils.findJLinkGDBServerCLExe();
			if (!jLink.available || !jLink.path) {
				APLaunchConfigurationProvider.log.log('JLink not available, cannot fetch STM32 targets');
				return [];
			}

			// Get the directory where JLink is installed
			const jLinkDir = path.dirname(jLink.path);
			APLaunchConfigurationProvider.log.log(`Found JLink at: ${jLinkDir}`);

			// Determine which executable to use based on platform
			const jLinkExe = jLink.path.replace(/JLinkGDBServerCL/g, 'JLink');

			// Check if the executable exists
			if (!fs.existsSync(jLinkExe)) {
				APLaunchConfigurationProvider.log.log(`JLink executable not found at: ${jLinkExe}`);
				return [];
			}

			APLaunchConfigurationProvider.log.log(`Using JLink executable: ${jLinkExe}`);

			// Use child_process.execSync to run JLink with ExpDevList command
			const tmpOutputFile = `jlink_devices_${Date.now()}`;
			const command = `"${jLinkExe}" -NoGui 1 -CommandFile ${tmpOutputFile}.cmd`;

			// Create command file with JLink commands
			fs.writeFileSync(`${tmpOutputFile}.cmd`, `ExpDevList ${tmpOutputFile}.txt\nexit\n`);

			// Execute JLink command
			APLaunchConfigurationProvider.log.log(`Running command: ${command}`);
			let output = '';
			try {
				child_process.execSync(command, {
					timeout: 10000,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				// Read the output file
				output = fs.readFileSync(`${tmpOutputFile}.txt`, 'utf8');
			} catch (error) {
				// JLink might return non-zero exit code but still output the device list
				if (error instanceof Error && 'stdout' in error) {
					// @ts-expect-error - error.stdout is available in ExecSyncError
					output = error.stdout.toString();
					APLaunchConfigurationProvider.log.log(`JLink command failed with error: ${output}`);
				} else {
					throw error;
				}
			}

			// Clean up the command file
			try {
				fs.unlinkSync(`${tmpOutputFile}.cmd`);
			} catch {
				// Ignore errors from deleting the file
			}

			// Extract STM32 devices from the output
			const devices: string[] = [];

			// Parse output for STM32 devices
			// Read the device list file if it exists
			if (fs.existsSync(`${tmpOutputFile}.txt`)) {
				const fileContent = fs.readFileSync(`${tmpOutputFile}.txt`, 'utf8');
				const lines = fileContent.split('\n');
				// Process each line
				for (const line of lines) {
					// Look for lines that match STM32 device pattern
					if (line.includes('"ST"') && line.includes('STM32')) {
						// Extract the device name which is the second quoted string
						const match = line.match(/"([^"]+)"[^"]*"([^"]+)"/);
						if (match && match.length >= 3 && match[2].startsWith('STM32')) {
							devices.push(match[2]);
						}
					}
				}

				// Clean up the output file
				try {
					fs.unlinkSync(`${tmpOutputFile}.txt`);
				} catch {
					// Ignore errors from deleting the file
				}
			}
			APLaunchConfigurationProvider.log.log(`Found ${devices.length} STM32 targets in JLink device list`);
			return devices;
		} catch (error) {
			APLaunchConfigurationProvider.log.log(`Error getting JLink STM32 targets: ${error}`);
			return [];
		}
	}

	private async handleDebugSessionTermination(session: vscode.DebugSession) {
		// Only handle termination of our own debug sessions (SITL)
		if (session.configuration.type === 'cppdbg' && this.tmuxSessionName && this.debugSessionTerminal) {
			APLaunchConfigurationProvider.log.log(`Debug session terminated, cleaning up tmux session: ${this.tmuxSessionName}`);

			// Find tmux path
			const tmux = await ProgramUtils.findTmux();
			const tmuxPath = tmux.available && tmux.path ? tmux.path : 'tmux';

			// Kill the tmux session
			// Create a separate terminal to kill the tmux session
			const cleanupTerminal = vscode.window.createTerminal('ArduPilot SITL Cleanup');
			cleanupTerminal.sendText(`"${tmuxPath}" kill-session -t "${this.tmuxSessionName}"`);
			cleanupTerminal.sendText('exit'); // Close the cleanup terminal when done

			// Close the debug session terminal as well
			this.debugSessionTerminal.dispose();

			// Reset the session tracking variables
			this.tmuxSessionName = undefined;
			this.debugSessionTerminal = undefined;
		}
	}

	public async resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration
	): Promise<vscode.DebugConfiguration | undefined> {
		// If launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const message = 'Cannot launch ArduPilot debug session. Please create a launch configuration.';
			vscode.window.showErrorMessage(message);
			return undefined;
		}

		// Make sure it's an apLaunch type
		if (config.type !== 'apLaunch') {
			return config;
		}

		// Cast to APLaunchDefinition after validation
		if (!config.target) {
			vscode.window.showErrorMessage('ArduPilot launch configuration requires \'target\' properties.');
			return undefined;
		}

		const apConfig = config as unknown as APLaunchDefinition;

		// Get the workspace root
		const workspaceRoot = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('No workspace is open.');
			return undefined;
		}

		// Set default waf file if not specified
		if (!apConfig.waffile) {
			apConfig.waffile = path.join(workspaceRoot, 'waf');
		}

		if (config.preLaunchTask) {
			// preLaunchTask is specified as <type>: <taskname>
			// find and execute it
			// Parse the task identifier (format: "<type>: <taskname>")
			const taskParts = config.preLaunchTask.split(':');
			if (taskParts.length !== 2) {
				vscode.window.showErrorMessage(`Invalid preLaunchTask format '${config.preLaunchTask}'. Expected format is 'type: taskname'`);
				return undefined;
			}

			const taskType = taskParts[0].trim();
			const taskName = taskParts[1].trim();

			// Find the task by type and name
			const tasks = await vscode.tasks.fetchTasks({ type: taskType });
			const task = tasks.find(t => t.name === taskName);

			if (!task) {
				vscode.window.showErrorMessage(`Pre-launch task '${taskName}' of type '${taskType}' not found.`);
				return undefined;
			}

			// Execute the task and wait for it to complete
			try {
				// executeTask in terminal
				const execution = await vscode.tasks.executeTask(task);

				// Create a promise that resolves when the task completes
				const taskExecution = new Promise<void>((resolve, reject) => {
					const disposable = vscode.tasks.onDidEndTaskProcess(e => {
						if (e.execution === execution) {
							disposable.dispose();
							if (e.exitCode === 0) {
								resolve();
							} else {
								reject(new Error(`Task '${task.name}' failed with exit code ${e.exitCode}`));
							}
						}
					});
				});

				// Wait for the task to complete
				await taskExecution;
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to execute pre-launch task: ${error}`);
				return undefined;
			}
		}

		try {
			if (config.isSITL) {
				// For SITL builds
				const simVehiclePath = path.join(workspaceRoot, 'Tools', 'autotest', 'sim_vehicle.py');

				// Extract vehicle type from target (e.g., 'copter' from 'sitl-copter')
				const vehicleType = apConfig.target.replace('sitl-', '');

				// Check if GDB is available
				const gdb = await ProgramUtils.findGDB();
				if (!gdb.available) {
					vscode.window.showErrorMessage('GDB not found. Please install GDB to debug SITL.');
					return undefined;
				}

				// Check if tmux is available
				const tmux = await ProgramUtils.findTmux();
				if (!tmux.available || !tmux.path) {
					vscode.window.showErrorMessage('tmux not found. Please install tmux to debug SITL.');
					return undefined;
				}

				// Find the binary path for the vehicle
				const binaryPath = path.join(workspaceRoot, 'build', 'sitl', targetToBin[vehicleType]);
				APLaunchConfigurationProvider.log.log(`Debug binary path: ${binaryPath}`);

				// Generate a unique port for gdbserver (between 3000-4000)
				const gdbPort = 3000 + Math.floor(Math.random() * 1000);

				// check if run_in_terminal_window.sh contains TMUX_PREFIX
				if (!fs.existsSync(path.join(workspaceRoot, 'Tools', 'autotest', 'run_in_terminal_window.sh'))) {
					vscode.window.showErrorMessage('run_in_terminal_window.sh not found. Please clone ArduPilot to debug SITL.');
					return undefined;
				} else {
					// check file contains TMUX_PREFIX
					const fileContent = fs.readFileSync(path.join(workspaceRoot, 'Tools', 'autotest', 'run_in_terminal_window.sh'), 'utf8');
					if (!fileContent.includes('TMUX_PREFIX')) {
						// if it doesn't contain TMUX_PREFIX, replace it with run_in_terminal_window.sh from resources, do backup of existing file
						const backupPath = path.join(workspaceRoot, 'Tools', 'autotest', 'run_in_terminal_window.sh.bak');
						if (!fs.existsSync(backupPath)) {
							// backup the existing file
							fs.copyFileSync(path.join(workspaceRoot, 'Tools', 'autotest', 'run_in_terminal_window.sh'), backupPath);
						}
						const runInTerminalWindowPath = path.join(__dirname, '..', 'resources', 'run_in_terminal_window.sh');
						if (fs.existsSync(runInTerminalWindowPath)) {
							// write the data to the file
							fs.writeFileSync(path.join(workspaceRoot, 'Tools', 'autotest', 'run_in_terminal_window.sh'), fs.readFileSync(runInTerminalWindowPath));
						}
					}
				}

				// Generate a unique tmux session name
				this.tmuxSessionName = `ardupilot_sitl_${vehicleType}_${Date.now()}`;

				// Set up the environment to use gdbserver through TMUX_PREFIX
				const tmuxPath = tmux.path; // Use the discovered tmux path
				const tmuxCommand = `"${tmuxPath}" new-session -s "${this.tmuxSessionName}" -n "SimVehicle"`;
				const simVehicleCmd = `export TMUX_PREFIX="gdbserver localhost:${gdbPort}" && python3 ${simVehiclePath} --no-rebuild -v ${vehicleType} ${apConfig.simVehicleCommand || ''}`;
				APLaunchConfigurationProvider.log.log(`Running SITL simulation with debug: ${simVehicleCmd}`);

				// Start the SITL simulation in a terminal and store the terminal reference
				this.debugSessionTerminal = vscode.window.createTerminal('ArduPilot SITL');
				this.debugSessionTerminal.sendText(`cd ${workspaceRoot}`);
				// Check if tmux session already exists before creating it
				this.debugSessionTerminal.sendText(`if ! "${tmuxPath}" has-session -t "${this.tmuxSessionName}" 2>/dev/null; then ${tmuxCommand}; fi`);
				this.debugSessionTerminal.sendText('sleep 1'); // Give tmux a moment to start
				this.debugSessionTerminal.sendText(`if ! "${tmuxPath}" has-session -t "${this.tmuxSessionName}" 2>/dev/null; then ${tmuxCommand}; fi`);
				this.debugSessionTerminal.sendText(`"${tmuxPath}" set mouse on`);
				this.debugSessionTerminal.sendText(simVehicleCmd);

				this.debugSessionTerminal.show();

				// Create a debug configuration for the C++ debugger
				const cppDebugConfig = {
					type: 'cppdbg',
					request: 'launch',
					name: `Debug ${vehicleType} SITL`,
					miDebuggerServerAddress: `localhost:${gdbPort}`,
					program: binaryPath,
					args: [],
					stopAtEntry: false,
					cwd: workspaceRoot,
					environment: [],
					externalConsole: false,
					MIMode: 'gdb',
					miDebuggerPath: gdb.path,
					setupCommands: [
						{
							description: 'Enable pretty-printing for gdb',
							text: '-enable-pretty-printing',
							ignoreFailures: true
						},
						{
							description: 'Set Disassembly Flavor to Intel',
							text: '-gdb-set disassembly-flavor intel',
							ignoreFailures: true
						}
					]
				};
				// Start the C++ debugger
				APLaunchConfigurationProvider.log.log('Starting C++ debugger session');
				return cppDebugConfig;
			} else {
				// For physical board builds, check if we need to debug or just upload
				if (config.request === 'launch' && config.type === 'apLaunch') {
					const mcuInfo = {
						mcuClass: apConfig.mcuClass,
						mcuName: apConfig.mcuName
					};
					// Determine which debugger to use (OpenOCD or JLink)
					const debuggerInfo = await this.determineDebuggerType(apConfig, mcuInfo);
					APLaunchConfigurationProvider.log.log(`Using ${debuggerInfo.type} debugger for target ${apConfig.target}`);

					// Get paths for the required tools
					const gdb = await ProgramUtils.findArmGDB();
					if (!gdb.available || !gdb.path) {
						vscode.window.showErrorMessage('ARM GDB not found. Please install arm-none-eabi-gdb or gdb-multiarch to debug hardware targets.');
						return undefined;
					}

					// ELF file path for the target (compiled firmware), it can be found in using targetToBin
					const elfFile = path.join(workspaceRoot, 'build', apConfig.configure, targetToBin[apConfig.target]);

					if (debuggerInfo.type === 'openocd') {
						return this.createOpenOCDDebugConfig(workspaceRoot, apConfig, mcuInfo, gdb.path, elfFile, debuggerInfo.device);
					} else {
						return this.createJLinkDebugConfig(workspaceRoot, apConfig, mcuInfo, gdb.path, elfFile, debuggerInfo.device);
					}
				} else {
					// Just upload the firmware without debugging
					const terminal = vscode.window.createTerminal('ArduPilot Upload');
					terminal.sendText(`cd ${workspaceRoot}`);

					const uploadCommand = `python3 ${apConfig.waffile} ${apConfig.target} --upload`;
					APLaunchConfigurationProvider.log.log(`Running upload command: ${uploadCommand}`);

					terminal.sendText(uploadCommand);
					terminal.show();
				}
			}

			// If we're here and we're not debugging, return undefined
			// to prevent VS Code from trying to start a debug session
			return undefined;
		} catch (error) {
			vscode.window.showErrorMessage(`Error in APLaunch: ${error}`);
			return undefined;
		}
	}

	/**
	 * Determines which debugger type to use based on configuration and availability
	 * @param config The launch configuration
	 * @param mcuInfo The MCU information
	 * @returns The debugger type to use ('openocd' or 'jlink') and selected device
	 */
	private async determineDebuggerType(config: APLaunchDefinition, mcuInfo: {mcuClass?: string, mcuName?: string}): Promise<{type: 'openocd' | 'jlink', device?: string}> {
		// If user specified a preferred debugger, use that
		if (config.preferredDebugger) {
			const debuggerType = config.preferredDebugger;
			let device: string | undefined = undefined;

			// Get device through selection
			if (debuggerType === 'openocd' && mcuInfo.mcuClass) {
				device = await this.selectOpenOCDTarget(mcuInfo.mcuClass);
			} else if (debuggerType === 'jlink' && mcuInfo.mcuName) {
				device = await this.selectJLinkDevice(mcuInfo.mcuName);
			}

			return { type: debuggerType, device };
		}

		// Check if OpenOCD is available
		const openOCD = await ProgramUtils.findOpenOCD();
		// Check if JLink is available
		const jLink = await ProgramUtils.findJLinkGDBServerCLExe();

		// Create a list of available debuggers
		const availableDebuggers: {label: string, value: 'openocd' | 'jlink', description: string}[] = [];

		if (openOCD.available && openOCD.path) {
			const description = 'STLink debugger';
			availableDebuggers.push({ label: 'STLink', value: 'openocd', description });
		}

		if (jLink.available && jLink.path) {
			const description = 'JLink debugger';
			availableDebuggers.push({ label: 'JLink', value: 'jlink', description });
		}

		// If no debuggers are available, return a default
		if (availableDebuggers.length === 0) {
			APLaunchConfigurationProvider.log.log('No debuggers available, defaulting to STLink');
			return { type: 'openocd' };
		}

		// If only one debugger is available, use it
		if (availableDebuggers.length === 1) {
			APLaunchConfigurationProvider.log.log(`Only one debugger available: ${availableDebuggers[0].value}`);

			const debuggerType = availableDebuggers[0].value;
			let device: string | undefined = undefined;

			// Get device through selection
			if (debuggerType === 'openocd' && mcuInfo.mcuClass) {
				device = await this.selectOpenOCDTarget(mcuInfo.mcuClass);
			} else if (debuggerType === 'jlink' && mcuInfo.mcuName) {
				device = await this.selectJLinkDevice(mcuInfo.mcuName);
			}

			return { type: debuggerType, device };
		}

		// Ask the user to choose a debugger
		const selectedDebugger = await vscode.window.showQuickPick(
			availableDebuggers,
			{
				placeHolder: 'Select a debugger to use',
				title: 'ArduPilot Debugger Selection',
			}
		);

		// If user cancelled the selection, choose a default
		if (!selectedDebugger) {
			APLaunchConfigurationProvider.log.log('User cancelled debugger selection, choosing default');

			// Default to OpenOCD if available, otherwise JLink
			if (openOCD.available && openOCD.path) {
				return { type: 'openocd' };
			} else if (jLink.available && jLink.path) {
				return { type: 'jlink' };
			}

			// Default to OpenOCD as last resort
			return { type: 'openocd' };
		}

		APLaunchConfigurationProvider.log.log(`User selected ${selectedDebugger.label} debugger`);

		// Now show device selection based on the selected debugger type
		let selectedDevice: string | undefined = undefined;

		if (selectedDebugger.value === 'openocd' && mcuInfo.mcuClass) {
			selectedDevice = await this.selectOpenOCDTarget(mcuInfo.mcuClass);
		} else if (selectedDebugger.value === 'jlink' && mcuInfo.mcuName) {
			selectedDevice = await this.selectJLinkDevice(mcuInfo.mcuName);
		}

		return { type: selectedDebugger.value, device: selectedDevice };
	}

	/**
	 * Shows a QuickPick of OpenOCD targets and lets the user select one
	 * @param mcuClass The MCU class to find targets for
	 * @returns The selected target or undefined if user cancels
	 */
	private async selectOpenOCDTarget(mcuClass: string): Promise<string | undefined> {
		// Filter targets that might be relevant for this MCU class
		const normalizedClass = mcuClass.toLowerCase();

		// Extract first 6 characters to match MCU class family (e.g., stm32h7)
		// Make sure we have enough characters and handle shorter MCU class strings
		const prefix = normalizedClass.length >= 6 ?
			normalizedClass.substring(0, 6) :
			normalizedClass;

		APLaunchConfigurationProvider.log.log(`Filtering OpenOCD targets for MCU class ${mcuClass} using prefix: ${prefix}`);
		const relevantTargets = APLaunchConfigurationProvider.openOCDTargets.filter(target => {
			// Include targets that match the first 6 chars of the MCU class
			// This will match patterns like stm32h7x and stm32h7x_dual_bank for STM32H7xx
			return target.toLowerCase().includes(prefix);
		});

		// If no relevant targets found, return undefined
		if (relevantTargets.length === 0) {
			APLaunchConfigurationProvider.log.log(`No OpenOCD targets found for ${mcuClass}`);
			return undefined;
		}

		// Prepare QuickPick items
		const targetItems = relevantTargets.map(target => ({
			label: target,
			description: '',
		}));

		// Show the QuickPick
		const selectedTarget = await vscode.window.showQuickPick(
			targetItems,
			{
				placeHolder: `Select OpenOCD target for ${mcuClass}`,
				title: 'ArduPilot OpenOCD Target Selection',
			}
		);

		// If user cancelled, return undefined
		if (!selectedTarget) {
			APLaunchConfigurationProvider.log.log('User cancelled OpenOCD target selection');
			return undefined;
		}

		APLaunchConfigurationProvider.log.log(`User selected OpenOCD target: ${selectedTarget.label}`);
		return selectedTarget.label;
	}

	/**
	 * Shows a QuickPick of JLink devices and lets the user select one
	 * @param mcuName The MCU name to find devices for
	 * @returns The selected device or undefined if user cancels
	 */
	private async selectJLinkDevice(mcuName: string): Promise<string | undefined> {
		// Filter devices that might be relevant for this MCU
		const normalizedName = mcuName.toUpperCase();
		const mcuNameBase = normalizedName.match(/^(STM32[A-Z]\d{1,3})/i);
		const basePrefix = mcuNameBase && mcuNameBase[1] ? mcuNameBase[1] : normalizedName.substring(0, 6);

		const relevantDevices = APLaunchConfigurationProvider.jLinkTargets.filter(device => {
			// Include devices that match part of the MCU name
			return device.toUpperCase().includes(basePrefix);
		});

		// If no relevant devices found, return undefined
		if (relevantDevices.length === 0) {
			APLaunchConfigurationProvider.log.log(`No JLink devices found for ${mcuName}`);
			return undefined;
		}

		// Prepare QuickPick items
		const deviceItems = relevantDevices.map(device => ({
			label: device,
			description: '',
		}));

		// Show the QuickPick
		const selectedDevice = await vscode.window.showQuickPick(
			deviceItems,
			{
				placeHolder: `Select JLink device for ${mcuName}`,
				title: 'ArduPilot JLink Device Selection',
			}
		);

		// If user cancelled, return undefined
		if (!selectedDevice) {
			APLaunchConfigurationProvider.log.log('User cancelled JLink device selection');
			return undefined;
		}

		APLaunchConfigurationProvider.log.log(`User selected JLink device: ${selectedDevice.label}`);
		return selectedDevice.label;
	}

	/**
	 * Creates a cortex-debug configuration for OpenOCD
	 * @param workspaceRoot The workspace root path
	 * @param config The launch configuration
	 * @param mcuInfo The MCU information
	 * @param gdbPath The path to the GDB executable
	 * @param elfFile The path to the ELF file
	 * @param selectedDevice Optional user-selected OpenOCD target
	 * @returns The debug configuration
	 */
	private async createOpenOCDDebugConfig(
		workspaceRoot: string,
		config: APLaunchDefinition,
		mcuInfo: {mcuClass?: string, mcuName?: string},
		gdbPath: string,
		elfFile: string,
		selectedDevice?: string
	): Promise<vscode.DebugConfiguration> {
		const openOCD = await ProgramUtils.findOpenOCD();
		if (!openOCD.available || !openOCD.path) {
			throw new Error('OpenOCD not found. Please install OpenOCD to debug hardware targets.');
		}

		// Use the selected device if provided, otherwise prompt user to select one
		let targetConfig = selectedDevice;
		if (!targetConfig && mcuInfo.mcuClass) {
			targetConfig = await this.selectOpenOCDTarget(mcuInfo.mcuClass);
		}

		// get SVD file for the deviceName
		const svdPath = mcuInfo?.mcuName ? await this.findSVDFile(mcuInfo.mcuName) : undefined;
		if (svdPath) {
			// Set the SVD file in the configuration
			APLaunchConfigurationProvider.log.log(`Using SVD file: ${svdPath}`);
		}
		if (!targetConfig) {
			throw new Error(`No OpenOCD target selected for MCU class: ${mcuInfo.mcuClass}`);
		}

		// Display confirmation to the user
		const message = `Using OpenOCD target: ${targetConfig} for MCU class: ${mcuInfo.mcuClass}`;
		const gdbPort = 50000;
		vscode.window.showInformationMessage(message);
		APLaunchConfigurationProvider.log.log(message);

		// fetch the path to openocd-helper.tcl
		let openOCDHelperPath = path.join(APTaskProvider.getExtensionUri().fsPath, 'resources', 'openocd-helper.tcl');
		let openocdScriptPath = path.join(path.dirname(openOCD.path), '../scripts');
		if (ProgramUtils.isWSL()) {
			openOCDHelperPath = ProgramUtils.wslPathToWin(openOCDHelperPath);
			openOCDHelperPath = openOCDHelperPath.replace(/\\/g, '\\\\');
			// script path for OpenOCD
			openocdScriptPath = ProgramUtils.wslPathToWin(openocdScriptPath);
			openocdScriptPath = openocdScriptPath.replace(/\\/g, '\\\\');
		}
		const openOCDCommand = `"${openOCD.path}" -c "gdb_port ${gdbPort}" -f "${openOCDHelperPath}"` +
		` -f interface/stlink.cfg -f target/${targetConfig}.cfg -c "CDRTOSConfigure chibios" -c "CDLiveWatchSetup"` +
		' -c "bindto 0.0.0.0"' +
		' -c "init"' +
		' -c "reset init"' +
		` -s "${openocdScriptPath}"`;
		// Show and execute the command in the terminal
		const openOCDTerminal = vscode.window.createTerminal('OpenOCD');
		openOCDTerminal.sendText(openOCDCommand);
		openOCDTerminal.show();

		let gdbTarget = `localhost:${gdbPort}`;

		if (ProgramUtils.isWSL()) {
			gdbTarget = `${ProgramUtils.wslIP()}:${gdbPort}`;
		}
		// Wait a moment for the server to start
		await new Promise(resolve => setTimeout(resolve, 2000));
		// Create a cortex-debug configuration
		const debugConfig: vscode.DebugConfiguration = {
			type: 'cortex-debug',
			request: 'launch',
			name: `Debug ${config.target} with OpenOCD`,
			cwd: workspaceRoot,
			executable: elfFile,
			servertype: 'external',
			runToEntryPoint: 'Reset_Handler',
			objdumpPath: 'arm-none-eabi-objdump',
			nmPath: 'arm-none-eabi-nm',
			gdbTarget,
			svdPath
		};

		if (openOCD.path) {
			debugConfig.serverpath = openOCD.path;
		}

		if (gdbPath) {
			debugConfig.gdbPath = gdbPath;
		}

		return debugConfig;
	}

	/**
	 * Creates a cortex-debug configuration for JLink
	 * @param workspaceRoot The workspace root path
	 * @param config The launch configuration
	 * @param mcuInfo The MCU information
	 * @param gdbPath The path to the GDB executable
	 * @param executable The path to the ELF file
	 * @param selectedDevice Optional user-selected JLink device
	 * @returns The debug configuration
	 */
	private async createJLinkDebugConfig(
		workspaceRoot: string,
		config: APLaunchDefinition,
		mcuInfo: {mcuClass?: string, mcuName?: string},
		gdbPath: string,
		executable: string,
		selectedDevice?: string
	): Promise<vscode.DebugConfiguration> {
		const jLink = await ProgramUtils.findJLinkGDBServerCLExe();
		if (!jLink.available || !jLink.path) {
			throw new Error('JLink GDB Server not found. Please install JLink tools to debug hardware targets.');
		}

		// Use the selected device if provided, otherwise prompt user to select one
		let deviceName = selectedDevice;
		if (!deviceName && mcuInfo.mcuName) {
			deviceName = await this.selectJLinkDevice(mcuInfo.mcuName);
		}

		if (!deviceName) {
			throw new Error(`No JLink device selected for MCU name: ${mcuInfo.mcuName}`);
		}

		// get SVD file for the deviceName
		const svdPath = await this.findSVDFile(deviceName);
		if (svdPath) {
			// Set the SVD file in the configuration
			APLaunchConfigurationProvider.log.log(`Using SVD file: ${svdPath}`);
		}
		// Display confirmation to the user
		const message = `Using JLink device: ${deviceName} for MCU name: ${mcuInfo.mcuName}`;
		vscode.window.showInformationMessage(message);
		APLaunchConfigurationProvider.log.log(message);

		// Use port 50000 for GDB server
		const gdbPort = 50000;

		// Launch JLink GDB Server manually in a separate terminal
		const jLinkTerminal = vscode.window.createTerminal('JLink GDB Server');

		let pluginPath = ProgramUtils.getJLinkRTOSPluginPath();
		// modify the path to the resources directory so that it can be used by windows application using wslpath
		if (ProgramUtils.isWSL()) {
			pluginPath = ProgramUtils.wslPathToWin(path.join(APTaskProvider.getExtensionUri().fsPath, 'resources', 'RTOSPlugin_ChibiOS_x64.dll'));
			pluginPath = pluginPath.replace(/\\/g, '\\\\');
		}
		const jLinkCommand = `"${jLink.path}" -singlerun -device ${deviceName} -if SWD -speed auto -port ${gdbPort} -nogui -nolocalhostonly -rtos "${pluginPath}"`;

		// Show and execute the command in the terminal
		jLinkTerminal.sendText(jLinkCommand);
		jLinkTerminal.show();

		// Wait a moment for the server to start
		await new Promise(resolve => setTimeout(resolve, 2000));

		let gdbTarget = `localhost:${gdbPort}`;

		if (ProgramUtils.isWSL()) {
			gdbTarget = `${ProgramUtils.wslIP()}:${gdbPort}`;
		}

		// Create a cortex-debug configuration using external server type
		const debugConfig: vscode.DebugConfiguration = {
			type: 'cortex-debug',
			request: 'launch',
			name: `Debug ${config.target} with JLink (External)`,
			cwd: workspaceRoot,
			executable,
			servertype: 'external',
			gdbTarget,
			runToEntryPoint: 'Reset_Handler',
			objdumpPath: 'arm-none-eabi-objdump',
			nmPath: 'arm-none-eabi-nm',
			svdPath
		};
		if (gdbPath) {
			debugConfig.gdbPath = gdbPath;
		}

		return debugConfig;
	}

	/**
	 * Finds SVD files matching the given MCU name by searching in the Contents.txt file.
	 * If multiple SVD files match the MCU, the user will be prompted to select one.
	 * @param mcuName The MCU name to find SVD files for (e.g., 'STM32F427VI' or 'STM32H757XX')
	 * @returns The path to the selected SVD file or undefined if none found or user cancelled
	 */
	private async findSVDFile(mcuName: string): Promise<string | undefined> {
		// Normalize the MCU name (uppercase and remove any XX suffix)
		let normalizedMCUName = mcuName.toUpperCase();

		// If mcuName contains xx (like STM32H757xx), we strip it to get the base name (e.g., STM32H757)
		const baseNameMatch = normalizedMCUName.match(/^(.*?)(XX|xx)$/);
		if (baseNameMatch && baseNameMatch[1]) {
			// Use only the base part of the name for matching (e.g., STM32H757)
			normalizedMCUName = baseNameMatch[1];
			APLaunchConfigurationProvider.log.log(`MCU name contains xx, using base name: ${normalizedMCUName}`);
		}

		// if normalizedMCUName contains _ then split it and use the first part as the new normalizedMCUName name
		// and second part as the core name
		const coreNameMatch = normalizedMCUName.match(/^(STM32[A-Z0-9]+?)_(.*)/);
		let coreName: string | undefined = undefined;
		if (coreNameMatch && coreNameMatch[1]) {
			// Use only the base part of the name for matching (e.g., STM32H757)
			normalizedMCUName = coreNameMatch[1];
			coreName = coreNameMatch ? coreNameMatch[2] : undefined;
			APLaunchConfigurationProvider.log.log(`MCU name contains _, using base name: ${normalizedMCUName}, core name: ${coreName}`);
		}

		// Get the extension's resource path
		const resourcePath = path.join(APTaskProvider.getExtensionUri().fsPath, 'resources', 'STMicro');
		const contentFilePath = path.join(resourcePath, 'Contents.txt');

		// Read the Contents.txt file
		const contentFileData = fs.readFileSync(contentFilePath, 'utf8');
		const lines = contentFileData.split('\n');
		// Find all SVD files that match the MCU name
		const svdMatches = new Map<string, string[]>(); // Map of SVD file to list of MCUs it supports
		for (const line of lines) {
			const parts = line.split(',').map(part => part.trim());
			if (parts.length < 2) continue;
			// The last element should be the SVD file name
			const svdFile = parts[parts.length - 1].trim();
			if (!svdFile.endsWith('.svd')) continue;
			// if coreName is defined then check if the svdFile contains the coreName
			if (coreName && !svdFile.includes(coreName)) continue;
			// Check if any of the MCU names in this line match our search
			const mcuNames = parts.slice(0, parts.length - 1);
			for (const mcu of mcuNames) {
				if (mcu.startsWith(normalizedMCUName)) {
					// If we find an exact match, store it
					if (svdMatches.has(svdFile)) {
						svdMatches.get(svdFile)?.push(mcu);
					} else {
						svdMatches.set(svdFile, [mcu]);
					}
				}
			}
		}

		// If no matches found
		if (svdMatches.size === 0) {
			APLaunchConfigurationProvider.log.log(`No SVD file found for MCU: ${mcuName}`);
			return undefined;
		}

		// If only one SVD file matches, return it directly
		if (svdMatches.size === 1) {
			const svdFile = Array.from(svdMatches.keys())[0];
			const svdPath = path.join(resourcePath, svdFile);

			APLaunchConfigurationProvider.log.log(`Found single SVD match: ${svdFile} for MCU: ${mcuName}`);
			return svdPath;
		}

		// If multiple SVD files match, let the user choose
		const items: vscode.QuickPickItem[] = Array.from(svdMatches.entries()).map(([svdFile, mcus]) => {
			return {
				label: svdFile,
				description: `Supports: ${mcus.join(', ')}`,
				detail: `Select this SVD file for debugging ${mcuName}`
			};
		});

		const selectedSvd = await vscode.window.showQuickPick(items, {
			placeHolder: `Multiple SVD files found for ${mcuName}. Please select one:`,
			title: 'SVD File Selection'
		});

		if (!selectedSvd) {
			APLaunchConfigurationProvider.log.log('SVD file selection cancelled by user');
			return undefined;
		}

		const svdPath = path.join(resourcePath, selectedSvd.label);
		APLaunchConfigurationProvider.log.log(`User selected SVD file: ${selectedSvd.label}`);
		return svdPath;
	}
}
