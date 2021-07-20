/* eslint-disable no-case-declarations */
/* eslint-disable guard-for-in */
/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable camelcase */
/* eslint-disable no-useless-concat */
/* eslint-disable no-prototype-builtins */
/* eslint-disable eqeqeq */
/* eslint-disable no-await-in-loop */
import minimist from 'minimist';
import fs from 'fs';
import cp from 'child_process';
import chalk from 'chalk';
import Spawn from './spawn';
import sleep from './sleep';
import ora from 'ora';
import {DIR_TASKS, DIR_WORKSHOP, _userConfig, DIR_BUILDS, MAX_BUILDS} from './const';
import {Interface, Task, PageInfo, DatabaseNode} from './class';
import {Status, Cmp} from './enum';
import {log, getMD5, gbk, xcopy, mv, matchVersion, formatVersion, versionCmp, copyCover} from './utils';
import {uploadToRemote} from './remote';
import {removeExtraBuilds} from './helper';
import {preprocessPA} from './helper';
import {scrapePage} from './scraper';
import {WebSocket as Aria2} from 'libaria2-ts';
export const args = minimist(process.argv.slice(2));

let aria2: Aria2.Client;
let _spawn: Spawn;

async function spawnAria2() {
	if (_userConfig.resolved.spawnAria2) {
		_spawn = new Spawn(_userConfig);
		_spawn.all();
		_spawn.promise().catch(e => {
			console.error(e);
			throw e;
		});
		await sleep(1500);
	}

	aria2 = new Aria2.Client({
		host: _userConfig.resolved.aria2Host,
		port: _userConfig.resolved.aria2Port,
		auth: {
			secret: _userConfig.resolved.aria2Secret,
		},
	});
	try {
		const ver = await aria2.getVersion();
		log('Info:Aria2 ready, ver = ' + ver.version);
		return true;
	} catch (e) {
		console.log(e);
		return false;
	}
}

// Task
function getTasks(): Array<string> {
	const dst = DIR_TASKS;
	const fileList = fs.readdirSync(dst);
	const result: string[] = [];
	fileList.forEach(item => {
		if (fs.statSync(dst + '/' + item).isDirectory()) {
			result.push(item);
		}
	});
	return result;
}

function readTaskConfig(name: string): Interface {
	const dir = DIR_TASKS + '/' + name;

	// 判断Task文件夹合法性
	if (
		!fs.existsSync(dir + '/config.json')
	) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Warning:Skipping illegal task directory ' + name,
		});
	}

	// 解析Json
	const json = JSON.parse(fs.readFileSync(dir + '/config.json').toString()) as Task;

	// 检查文件夹名称和json.name是否一致
	if (name !== json.name) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Value of config\'s key "name" is not ' + name,
		});
	}

	// 检查Json健全性
	let miss = null;
	for (const taskKey in new Task()) {
		if (!json.hasOwnProperty(taskKey)) {
			miss = taskKey;
			break;
		}
	}

	if (miss) {
		return new Interface({
			status: Status.ERROR,
			payload:
                'Warning:Skipping illegal task config '
                + name
                + ',missing "'
                + miss
                + '"',
		});
	}

	// 检查分类是否存在
	const cates = ['实用工具', '开发辅助', '配置检测', '资源管理', '办公编辑', '输入法', '录屏看图', '磁盘数据', '安全急救', '即时通讯', '安装备份', '游戏娱乐', '运行环境', '压缩镜像', '美化增强', '驱动管理', '下载上传', '浏览器', '影音播放', '远程连接', '集成开发'];
	if (!cates.includes(json.category)) {
		return new Interface({
			status: Status.ERROR,
			payload:
                'Warning:Skipping illegal task config '
                + name
                + ',category "'
                + json.category
                + '" not exist',
		});
	}

	return new Interface({
		status: Status.SUCCESS,
		payload: json,
	});
} // Interface:Task

async function getWorkDirReady(
	task: Task,
	pageInfo: PageInfo,
	p7zip: string,
): Promise<Interface> {
	const {name} = task;
	const req = task.releaseRequirement;
	const url = pageInfo.href;
	const {md5} = pageInfo;
	const dir = DIR_WORKSHOP + '/' + name;

	// 创建目录，因为程序初始化时会将workshop目录重建
	fs.mkdirSync(dir);
	fs.mkdirSync(dir + '/' + 'build');

	// 通过aria2/wget下载
	log('Info:Start downloading ' + name);
	try {
		// Cp.execSync("wget -O target.exe " + url, {cwd: dir});
		const gid = await aria2.addUri(
			url,
			{
				dir,
				out: 'target.exe',
			},
			0,
		);
		let done = false;
		const progress = ora({
			text: 'Downloading ' + name + ', waiting...',
			prefixText: chalk.blue('Info'),
		});
		progress.start();
		while (!done) {
			await sleep(500);
			const status = await aria2.tellStatus(gid);
			if (status.status == 'error') {
				throw status;
			}

			if (status.status == 'complete') {
				done = true;
			}

			if (status.status == 'waiting') {
				await sleep(1000);
			}

			progress.text
                = 'Download progress: '
                + (Number(status.completedLength as bigint) / 1024 / 1024).toPrecision(
                	3,
                )
                + ' / '
                + (Number(status.totalLength as bigint) / 1024 / 1024).toPrecision(3)
                + ' MiB, Speed: '
                + (Number(status.downloadSpeed as bigint) / 1024 / 1024).toPrecision(3)
                + ' MiB/s';
		}

		progress.succeed(name + ' downloaded.');
	} catch (err: any) {
		console.log(JSON.stringify(err));
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Downloading ' + name + ' failed,skipping...',
		});
	}

	// 校验下载
	if (!fs.existsSync(dir + '/target.exe')) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Downloading ' + name + ' failed,skipping...',
		});
	}

	// 校验md5
	if (md5 && md5 !== '') {
		const md5_calc = await getMD5(dir + '/target.exe');
		if (md5.toLowerCase() !== md5_calc.toLowerCase()) {
			return new Interface({
				status: Status.ERROR,
				payload: 'Error:Task '
                    + name
                    + ' \'s MD5 checking failed,expected '
                    + md5
                    + ',got '
                    + md5_calc
                    + ',skipping...',
			});
		}
	}

	// 使用7-Zip解压至release文件夹
	log('Info:Start extracting ' + name);
	cp.execSync('"' + p7zip + '" x target.exe -orelease -y', {cwd: dir});

	// 检查目录是否符合规范
	let miss = null;
	for (const i in req) {
		const n = req[i];
		if (!fs.existsSync(dir + '/release/' + n)) {
			miss = n;
			break;
		}
	}

	if (miss) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Miss ' + miss + ' in ' + name + '\'s workshop,skipping...',
		});
	}

	// 复制make.cmd
	if (fs.existsSync(DIR_TASKS + '/' + name + '/make.cmd')) {
		try {
			fs.copyFileSync(DIR_TASKS + '/' + name + '/make.cmd', dir + '/make.cmd');
		} catch {
			return new Interface({
				status: Status.ERROR,
				payload: 'Error:Can\'t copy make.cmd for task ' + name,
			});
		}
	}

	// 复制utils
	if (fs.existsSync(DIR_TASKS + '/' + name + '/utils')) {
		if (!xcopy(DIR_TASKS + '/' + name + '/utils', dir + '/utils/')) {
			return new Interface({
				status: Status.ERROR,
				payload: 'Error:Can\'t copy utils for task ' + name,
			});
		}
	}

	log('Info:Workshop for ' + name + ' is ready');
	return new Interface({
		status: Status.SUCCESS,
		payload: 'Success',
	});
} // Interface:string

async function runMakeScript(name: string): Promise<Interface> {
	return new Promise<Interface>(resolve => {
		// 校验是否存在make.cmd
		if (!fs.existsSync(DIR_WORKSHOP + '/' + name + '/make.cmd')) {
			resolve(new Interface({
				status: Status.ERROR,
				payload: 'Error:make.cmd not found for task ' + name,
			}));
		}

		log('Info:Start making ' + name);

		// 启动make.cmd进程
		try {
			cp.execSync('make.cmd>make.log', {cwd: DIR_WORKSHOP + '/' + name, timeout: 600000});
		} catch {
			if (fs.existsSync(DIR_WORKSHOP + '/' + name + '/make.log')) {
				console.log('console output=======================');
				console.log(gbk(fs.readFileSync(DIR_WORKSHOP + '/' + name + '/make.log')));
				console.log('console output=======================');
			} else {
				log('Warning:make.cmd has no console output');
			}

			resolve(new Interface({
				status: Status.ERROR,
				payload: 'Error:Make error for ' + name + ',skipping...',
			}));
		}

		// 执行tree
		// console.log(gbk(cp.execSync("tree /F /A", { cwd: DIR_WORKSHOP + "/" + name})))

		// 成功
		if (fs.existsSync(DIR_WORKSHOP + '/' + name + '/make.log')) {
			console.log('console output=======================');
			console.log(gbk(fs.readFileSync(DIR_WORKSHOP + '/' + name + '/make.log')));
			console.log('console output=======================');
		} else {
			log('Warning:make.cmd has no console output');
		}

		resolve(new Interface({
			status: Status.SUCCESS,
			payload: 'Success',
		}));
	});
}

function autoMake(name: string): boolean {
	log('Info:Start auto make ' + name);
	const dir = DIR_WORKSHOP + '/' + name + '/release';

	// 扫描exe文件
	const files: Array<string> = fs.readdirSync(dir);

	// 找出可执行文件
	let exeFileName: string = '';
	files.forEach(item => {
		if (item.includes('.exe')) {
			log('Info:Got exe file:' + item);
			exeFileName = item;
		}
	});
	if (exeFileName !== '') {
		// 检查是否包含"Portable"
		if (!exeFileName.includes('Portable')) {
			log('Warning:Exe file may be wrong:' + exeFileName);
		}

		// 生成wcs文件
		const moveCmd = 'FILE X:\\Program Files\\Edgeless\\' + name + '_bot->X:\\Users\\PortableApps\\' + name + '_bot';
		const linkCmd = 'LINK X:\\Users\\Default\\Desktop\\' + name + ',X:\\Users\\PortableApps\\' + name + '_bot\\' + exeFileName;
		const cmd = moveCmd + '\n' + linkCmd;
		fs.writeFileSync(DIR_WORKSHOP + '/' + name + '/build/' + name + '_bot.wcs', cmd);
		log('Info:Save batch with command:\n' + cmd);

		// 移动文件夹
		if (!mv(DIR_WORKSHOP + '/' + name + '/release', DIR_WORKSHOP + '/' + name + '/build/' + name + '_bot')) {
			return false;
		}

		log('Info:Auto make executed successfully');
		return true;
	}

	log('Error:Can\'t find exe file,auto make failed');
	return false;
}

function buildAndDeliver(
	task: Task,
	version: string,
	p7zip: string,
	database: DatabaseNode,
): Interface {
	const {name} = task;
	const {category} = task;
	const {author} = task;
	const req = task.buildRequirement;
	const zname = name + '_' + version + '_' + author + '（bot）.7z';
	const dir = DIR_WORKSHOP + '/' + name;
	const repo = DIR_BUILDS + '/' + category;
	// 检查build requirements
	let miss = null;
	for (const i in req) {
		const n = req[i];
		if (!fs.existsSync(dir + '/build/' + n)) {
			miss = n;
			break;
		}
	}

	if (miss) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Miss ' + miss + ' in ' + name + '\'s final build,skipping...',
		});
	}

	// 压缩build文件夹内容
	log('Info:Start compressing into ' + zname);
	try {
		cp.execSync('"' + p7zip + '" a "' + zname + '" *', {cwd: dir + '/build'});
	} catch (err: any) {
		console.log(JSON.stringify(err));
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Compress ' + zname + ' failed,skipping...',
		});
	}

	// 检查压缩是否成功
	if (!fs.existsSync(dir + '/build/' + zname)) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Compress ' + zname + ' failed,skipping...',
		});
	}

	log('Info:Compressed successfully');

	// 移动至编译仓库
	if (!fs.existsSync(repo)) {
		fs.mkdirSync(repo);
	}

	let moveCmd
        = 'move "' + dir + '/build/' + zname + '" "' + repo + '/' + zname + '"';
	moveCmd = moveCmd.replace(/\//g, '\\');
	try {
		cp.execSync(moveCmd);
	} catch (err: any) {
		console.log(JSON.stringify(err));
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Can\'t move with command:' + moveCmd,
		});
	}

	if (!fs.existsSync(repo + '/' + zname)) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Can\'t move with command:' + moveCmd,
		});
	}

	// 删除过旧的编译版本
	if (database.builds.length >= MAX_BUILDS) {
		database = removeExtraBuilds(database, repo, category,version);
	}

	// 上传编译版本
	if (!uploadToRemote(zname, category)) {
		return new Interface({
			status: Status.ERROR,
			payload: 'Error:Can\'t upload file ' + zname,
		});
	}

	// 记录数据库
	database.latestVersion = version;
	database.builds.push({
		version,
		name: zname,
	});

	return new Interface({
		status: Status.SUCCESS,
		payload: database,
	});
} // Interface:DatabaseNode

// task processor
async function processTask(
	task: Task,
	database: DatabaseNode,
	p7zip: string,
): Promise<Interface> {
	log('Info:Start processing ' + task.name);

	// 抓取页面信息
	const iScrape = await scrapePage(task.paUrl, false);
	if (iScrape.status === Status.ERROR) {
		log(iScrape.payload as any);
		return new Interface({
			status: Status.ERROR,
			payload: (('Error:Can\'t scrape '
                + task.name
                + ' \'s page,skipping...') as unknown) as PageInfo,
		});
	}

	const pageInfo = iScrape.payload as PageInfo;

	// 匹配版本号
	const iVersion = matchVersion(pageInfo.text);
	if (iVersion.status === Status.ERROR) {
		log(iVersion.payload);
		return new Interface({
			status: Status.ERROR,
			payload:
                'Error:Can\'t match '
                + task.name
                + ' \'s version from page,skipping...',
		});
	}

	const version = formatVersion(iVersion.payload) as string;

	// 与数据库进行校对
	let ret: Interface;
	let cmpResult: Cmp = versionCmp(database.latestVersion, version);
	if (args.hasOwnProperty('f')) {
		cmpResult = Cmp.L;
	}

	switch (cmpResult) {
		case Cmp.L:
			// 需要升级
			const iGWR = await getWorkDirReady(task, pageInfo, p7zip);
			if (iGWR.status === Status.ERROR) {
				ret = iGWR;
				break;
			}

			if (task.preprocess && !preprocessPA(task.name)) {
				ret = new Interface({
					status: Status.ERROR,
					payload:
                        'Error:Can\'t preprocess ' + task.name + ',skipping...',
				});
				break;
			}

			if (task.autoMake) {
				if (!autoMake(task.name)) {
					ret = new Interface({
						status: Status.ERROR,
						payload:
                            'Error:Can\'t make ' + task.name + ' automatically,skipping...',
					});
					break;
				}
			} else {
				const iRM = await runMakeScript(task.name);
				if (iRM.status === Status.ERROR) {
					ret = iRM;
					break;
				}
			}

			if (!copyCover(task.name)) {
				ret = new Interface({
					status: Status.ERROR,
					payload:
                        'Error:Can\'t copy cover for ' + task.name + ',skipping...',
				});
				break;
			}

			let BAD_database: DatabaseNode;
			try {
				BAD_database = buildAndDeliver(
					task,
					version,
					p7zip,
					database,
				).unwarp();
			} catch (e) {
				ret = new Interface({
					status: Status.ERROR,
					payload: e,
				});
				break;
			}

			ret = new Interface({
				status: Status.SUCCESS,
				payload: BAD_database,
			});
			break;
		case Cmp.G:
			// 本地大于在线，异常
			log(
				'Warning:'
                + task.name
                + '\'s local version is greater than online version,local='
                + database.latestVersion
                + ',online='
                + version,
			);
			ret = new Interface({
				status: Status.SUCCESS,
				payload: database,
			});
			break;
		default:
			// 已是最新版本，不需要操作
			log(
				'Info:'
                + task.name
                + ' has been up to date,local='
                + database.latestVersion
                + ',online='
                + version,
			);
			ret = new Interface({
				status: Status.SUCCESS,
				payload: database,
			});
			break;
	}

	return ret;
} // Interface:DatabaseNode

export {
	processTask,
	spawnAria2,
	readTaskConfig,
	getTasks,
	aria2,
};
