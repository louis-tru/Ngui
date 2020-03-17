/* ***** BEGIN LICENSE BLOCK *****
 * Distributed under the BSD license:
 *
 * Copyright (c) 2015, xuewen.chu
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * Neither the name of xuewen.chu nor the
 *       names of its contributors may be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL xuewen.chu BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * 
 * ***** END LICENSE BLOCK ***** */

import util from 'nxkit/util';
import paths from './paths';
import * as fs from 'nxkit/fs';
import path from 'nxkit/path';
import keys from 'nxkit/keys';
import NguiBuild, {PackageJson} from './build';
import { getLocalNetworkHost } from 'nxkit/network_host';
import * as child_process from 'child_process';

const isWindows = process.platform == 'win32';

const native_source = [
	'.c',
	'.cc',
	'.cpp',
	'.cxx',
	'.m',
	'.mm',
	'.s', 
	'.swift',
	'.java',
];

function parse_json_file(filename: string) {
	try {
		return JSON.parse(fs.readFileSync(filename, 'utf-8'));
	} catch (err) {
		err.message = filename + ': ' + err.message;
		throw err;
	}
}

function resolveLocal(...args: string[]) {
	return path.fallbackPath(path.resolve(...args));
}

function filter_repeat(array: string[], ignore?: string) {
	var r: Dict = {};
	array.forEach(function(item) { 
		if ( !ignore || ignore != item ) {
			r[item] = 1;
		}
	});
	return Object.getOwnPropertyNames(r);
}

type PkgJson = PackageJson;

interface OutputGypi extends Dict {}

class Package {
	readonly host: NguiExport;
	readonly name: string;
	readonly gypi_path: string;
	readonly source_path: string;
	readonly pkg_json: PkgJson;
	readonly is_app: boolean;
	readonly includes: string[] = [];
	readonly include_dirs: string[] = [];
	readonly sources: string[] = [ 'public' ];
	readonly dependencies: string[] = [ '<@(libngui)' ];
	readonly dependencies_recursion: string[] = [ '<@(libngui)' ];
	readonly bundle_resources: string[] = [];
	private _binding = false;
	private _binding_gyp = false;
	private _native = false;
	private _gypi: OutputGypi | null = null;

	get native() {
		return this._native;
	}

	get gypi() {
		util.assert(this._gypi);
		return this._gypi as OutputGypi;
	}

	private get_start_argv() {
		var self = this;
		if ( self.is_app ) {
			var name = self.name;
			var pkg_json = self.pkg_json;
			var inspect = '--inspect=0.0.0.0:9229 ';
			var start_argv = name;
			var start_argv_debug = inspect + 'http://' + getLocalNetworkHost()[0] + ':1026/' + name;
			if ( pkg_json.skipInstall ) {
				console.warn( 'skipInstall params May lead to Application', name, ' to start incorrectly' );
			}
			return [start_argv, start_argv_debug].map(e=>`ngui ${e}`);
		}
		return [] as string[];
	}

	constructor(host: NguiExport, source_path: string, is_app?: boolean) {
		var pkg_json = parse_json_file(source_path + '/package.json');
		this.host = host;
		this.source_path = source_path;
		this.pkg_json = pkg_json;
		this.is_app = is_app || false;
		this.name = path.basename(source_path);
		this.gypi_path = host.output + '/' + this.name + '.gypi';
		this.initialize();
	}

	// reset app resources
	private set_dependencies() {
		var self = this;

		var includes: string[] = [];
		var dependencies: string[] = [];
		var dependencies_recursion: string[] = [...self.dependencies];
		var bundle_resources: string[] = [];
		var outputs = self.host.outputs;

		if (self.is_app)
			bundle_resources.push(...self.host.bundle_resources);

		for (var [k,v] of Object.entries(self.pkg_json.dependencies as Dict<string>)) {
			// TODO looking for the right package
			var version = v.replace(/^(~|\^)/, '');
			var fullname = k + '@' + version;
			var pkg = outputs[fullname];
			if (!pkg) {
				fullname = k;
				pkg = outputs[fullname];
			}
			if (pkg) {
				if (self.is_app) {
					includes.push(pkg.gypi_path, ...pkg.includes);
					dependencies_recursion.push(fullname, ...pkg.dependencies_recursion);
					bundle_resources.push(...pkg.bundle_resources);
				}
				dependencies.push(fullname);
			}
		}

		self.includes.splice(0, Infinity, ...filter_repeat(includes));
		self.dependencies.splice(0, Infinity, ...filter_repeat(dependencies, this.name));
		self.dependencies_recursion.splice(0, Infinity, ...filter_repeat(dependencies_recursion, this.name));
		self.bundle_resources.splice(0, Infinity, ...filter_repeat(bundle_resources));

		// is native
		for (var depe of self.dependencies_recursion) {
			var pkg = outputs[depe];
			if (pkg) {
				if (pkg._native || pkg._binding || pkg._binding_gyp) {
					this._native = true;
					break;
				}
			}
		}

	}

	private initialize() {
		var self = this;
		var host = this.host;
		var pkg_json = self.pkg_json;
		var source_path = this.source_path;
		var relative = path.relative(host.output, source_path);

		// add native and source
		if ( fs.existsSync(source_path + '/binding.gyp') ) {
			var targets = parse_json_file(source_path + '/binding.gyp').targets as any[];
			if (targets.length) {
				var target = targets[0];
				var target_name = target.target_name;
				self.dependencies.push(relative + '/binding.gyp:' + target_name);
				self._binding_gyp = true;
			}
		}
		else if ( fs.existsSync(source_path + '/binding') ) {
			fs.listSync(source_path + '/binding').forEach(function(stat) {
				if ( stat.name[0] != '.' ) {
					if ( stat.isFile() ) {
						var extname = path.extname(stat.name).toLowerCase();
						if (native_source.indexOf(extname) != -1) { // native source
							self._binding = true;
						}
					}
					self.sources.push( relative + '/binding/' + stat.name );
				}
			});
			if ( this._binding ) {
				this.include_dirs.push(relative + '/binding');
			}
		}

		// add source
		fs.listSync(source_path).forEach(function(stat) {
			if ( stat.name != 'binding' && stat.name[0] != '.' ) {
				if ( stat.isFile() ) {
					var extname = path.extname(stat.name).toLowerCase();
					if (native_source.indexOf(extname) == -1) {
						// not add native source
						self.sources.push( relative + '/' + stat.name );
					}
				} else {
					self.sources.push( relative + '/' + stat.name );
				}
			}
		});

		if ( !pkg_json.skipInstall ) { // no skip install pkg
			this.bundle_resources.push('install/' + this.name);
		}
	}

	private gen_ios_gypi(): OutputGypi {
		var self = this;
		var is_app = self.is_app;
		var name = self.name;
		var host = self.host;
		var sources = self.sources;
		var id = self.pkg_json.id || 'org.ngui.${PRODUCT_NAME:rfc1034identifier}';
		var app_name = self.pkg_json.app || '${EXECUTABLE_NAME}';
		var version = self.pkg_json.version;
		var xcode_settings = {};

		if ( is_app ) { // copy platfoem file

			xcode_settings = {
				'INFOPLIST_FILE': '<(XCODE_INFOPLIST_FILE)',
				//'OTHER_LDFLAGS': '-all_load',
				'SKIP_INSTALL': 'NO',
				'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon',
				'ASSETCATALOG_COMPILER_LAUNCHIMAGE_NAME': 'LaunchImage',
			};
	
			var out = host.proj_out;
			var template = __dirname + '/export/'+ host.os +'/';
			var plist = out + '/' + name + '.plist';
			var storyboard = out + '/' + name + '.storyboard';
			var xcassets = out + '/' + name + '.xcassets';
			var main = out + '/' + name + '.mm';
			var str;

			// .plist
			fs.cp_sync(template + 'main.plist', plist, { replace: false });
			str = fs.readFileSync(plist).toString('utf8');
			var reg0 = /(\<key\>CFBundleIdentifier\<\/key\>\n\r?\s*\<string\>)([^\<]+)(\<\/string\>)/;
			var reg1 = /(\<key\>CFBundleDisplayName\<\/key\>\n\r?\s*\<string\>)([^\<]+)(\<\/string\>)/;
			var reg2 = /(\<key\>CFBundleShortVersionString\<\/key\>\n\r?\s*\<string\>)([^\<]+)(\<\/string\>)/;
			str = str.replace(reg0, function(a,b,c,d) { return b + id + d });
			str = str.replace(reg1, function(a,b,c,d) { return b + app_name + d });
			if (version) str = str.replace(reg2, function(a,b,c,d) { return b + version + d });
			str = str.replace('[Storyboard]', name);
			fs.writeFileSync( plist, str );
			// .storyboard
			fs.cp_sync( template + 'main.storyboard', storyboard, { replace: false } );
			// .xcassets
			fs.cp_sync( template + 'Images.xcassets', xcassets, { replace: false } );
	
			self.bundle_resources.push('../Project/<(os)/' + name + '.storyboard');
			self.bundle_resources.push('../Project/<(os)/' + name + '.xcassets');

			if ( !fs.existsSync(main) ) { // main.mm
				var start_argv = self.get_start_argv();
				str = fs.readFileSync(template + 'main.mm').toString('utf8');
				str = str.replace(/ARGV_DEBUG/, start_argv[1]);
				str = str.replace(/ARGV_RELEASE/, start_argv[0]);
				fs.writeFileSync( main, str );
			}

			sources.push('../Project/<(os)/' + name + '.plist');
			sources.push('../Project/<(os)/' + name + '.storyboard');
			sources.push('../Project/<(os)/' + name + '.mm');
		}

		// create gypi json data

		var type = is_app ? 'executable' : self._binding ? 'static_library' : 'none';
		var gypi = 
		{
			'targets': [
				{
					'variables': is_app ? {
						'XCODE_INFOPLIST_FILE': '$(SRCROOT)/Project/<(os)/' + name + '.plist' 
					} : {},
					'target_name': name,
					'product_name': is_app ? name + '-1' : name,
					'type': type,
					'include_dirs': self.include_dirs,
					'dependencies': is_app ? self.dependencies_recursion: self.dependencies,
					'direct_dependent_settings': {
						'include_dirs': is_app ? [] : self.include_dirs,
					},
					'sources': sources,
					'mac_bundle': is_app ? 1 : 0,
					'mac_bundle_resources': is_app ? self.bundle_resources : [],
					'xcode_settings': xcode_settings,
				}
			]
		};

		return gypi;
	}

	private gen_android_gypi(): OutputGypi {
		var self = this;
		var is_app = self.is_app;
		var name = self.name;
		var host = self.host;
		var sources = self.sources;
		var id = (self.pkg_json.id || 'org.ngui.' + name).replace(/-/gm, '_');
		var app_name = self.pkg_json.app || name;
		var version = self.pkg_json.version;
		var java_pkg = id.replace(/\./mg, '/');
		var so_pkg = self.native ? name : 'ngui-js';

		if ( is_app ) { // copy platfoem file
			var proj_out = host.proj_out;
			var app = proj_out + '/' + name;
			var AndroidManifest_xml = `${app}/src/main/AndroidManifest.xml`;
			var strings_xml = `${app}/src/main/res/values/strings.xml`;
			var MainActivity_java = `${app}/src/main/java/${java_pkg}/MainActivity.java`;
			var build_gradle = `${app}/build.gradle`;

			// copy android project template
			fs.cp_sync(__dirname + '/export/android/proj_template', proj_out, { replace: false });
			// copy android app template
			fs.cp_sync(__dirname + '/export/android/app_template', proj_out + '/' + name, { replace: false });
	
			fs.mkdirpSync(proj_out + '/' + name + '/src/main/assets');
			fs.mkdirpSync(proj_out + '/' + name + '/src/main/java');

			var str: string;

			// MainActivity.java
			var start_argv = self.get_start_argv();
			fs.cp_sync(__dirname + '/export/android/MainActivity.java', MainActivity_java, { replace: false });
			str = fs.readFileSync(MainActivity_java).toString('utf8');
			str = str.replace(/\{id\}/gm, id);
			str = str.replace(/String\s+LIBRARY\s+=\s+"[^\"]+"/, `String LIBRARY = "${so_pkg}"`);
			str = str.replace(/ARGV_DEBUG/, start_argv[1]);
			str = str.replace(/ARGV_RELEASE/, start_argv[0]);
			fs.writeFileSync(MainActivity_java, str);

			// AndroidManifest.xml
			str = fs.readFileSync(AndroidManifest_xml).toString('utf8');
			str = str.replace(/package\=\"[^\"]+\"/mg, `package="${id}"`);
			str = str.replace(/android\:name\=\"android\.app\.lib_name\"\s+android\:value\=\"[^\"]+\"/, 
												`android:name="android.app.lib_name" android:value="${so_pkg}"`);
			fs.writeFileSync(AndroidManifest_xml, str);

			// strings.xml
			str = fs.readFileSync(strings_xml).toString('utf8');
			str = str.replace(/name\=\"app_name\"\>[^\<]+\</, `name="app_name">${app_name}<`);
			fs.writeFileSync(strings_xml, str);

			// build.gradle
			str = fs.readFileSync(build_gradle).toString('utf8');
			str = str.replace(/\{id\}/, id);
			str = str.replace(/applicationId\s+('|")[^\'\"]+('|")/, `applicationId '${id}'`);
			if (version) str = str.replace(/versionName\s+('|")[^\'\"]+('|")/, `versionName '${version}'`);
			fs.writeFileSync(build_gradle, str);
		}

		// create gypi json data

		var type = 'none';
		if ( is_app ) {
			if ( self.native ) {
				type = 'shared_library';
				if ( !self._binding ) {
					fs.writeFileSync(host.output, fs.readFileSync(__dirname + '/export/'));
					fs.cp_sync(__dirname + '/export/empty.c', host.output + '/empty.c', { replace: false });
					sources.push('empty.c');
				}
			}
		} else if ( self._binding ) {
			type = 'static_library';
		}

		var gypi = 
		{	
			'targets': [
				{
					'target_name': name,
					'type': type,
					'include_dirs': self.include_dirs,
					'dependencies': is_app ? self.dependencies_recursion: self.dependencies,
					'direct_dependent_settings': {
						'include_dirs': is_app ? [] : self.include_dirs,
					},
					'sources': sources,
				}
			]
		};

		return gypi;
	}

	gen() {
		if (!this._gypi) {
			this.set_dependencies();
			var os = this.host.os;
			if ( os == 'ios' ) {
				this._gypi = this.gen_ios_gypi();
			} else if ( os == 'android' ) {
				this._gypi = this.gen_android_gypi();
			} else {
				throw new Error('Not support');
			}
		}
		return this._gypi;
	}

}

export default class NguiExport {
	readonly source: string;
	readonly output: string;
	readonly proj_out: string;
	readonly os: string;
	readonly bundle_resources: string[];
	readonly outputs: Dict<Package> = {};
	private m_project_name = 'app';

	constructor(source: string, os: string) {
		var self = this;
		this.source = resolveLocal(source);
		this.output = resolveLocal(source, 'out');
		this.proj_out = resolveLocal(source, 'Project', os);
		this.os = os;

		function copy_libs(source: string) {
			var [source, symlink] = source.split(/\s+/);
			var libs = self.output + '/libs/';
			if (symlink) {
				source = libs + source;
				fs.mkdirpSync(path.dirname(source));
				if ( !fs.existsSync(source) ) {
					fs.symlinkSync(symlink, source);
				}
				return '';
			} else {
				var target = libs + path.basename(source);
				fs.copySync(source, target, { replace: false });
				return path.relative(self.output, target);
			}
		}
		// copy bundle resources and includes and librarys
		this.bundle_resources = paths.bundle_resources.map(copy_libs);

		if (paths.librarys[os])
			paths.librarys[os].forEach(copy_libs);
		paths.includes.forEach(copy_libs);

		var proj_keys = this.source + '/proj.keys';
		util.assert(fs.existsSync(proj_keys), 'Export source does not exist ,{0}', proj_keys);

		fs.mkdirpSync(this.output);
		fs.mkdirpSync(this.output + '/public');
		fs.mkdirpSync(this.proj_out);
	}

	private solve(pathname: string, is_app?: boolean): Package | null {
		var self = this;
		var source_path = resolveLocal(pathname);
		var fullname = path.basename(source_path);

		// ignore network pkg 
		if ( /^https?:\/\//i.test(source_path) ) {
			console.warn(`ignore extern network Dependencies pkg`);
			return null;
		}

		var pkg = self.outputs[fullname];
		if ( !pkg ) {
			self.outputs[fullname] = pkg = new Package(self, source_path, is_app);
		}

		return pkg;
	}

	private gen_project_file(project_name: string) {
		var self = this;
		var gyp_exec = __dirname + (isWindows ? '/gyp/gyp.bat' :  '/gyp/gyp');

		var os = self.os;
		var source = self.source;
		var project = 'make';
		var project_path: string[];
		var out = self.output;
		var proj_out = self.proj_out;

		if ( os == 'ios' ) {
			project = 'xcode';
			project_path = [ `${proj_out}/${project_name}.xcodeproj` ];
		} else if ( os == 'android' ) {
			project = 'cmake-linux';
			project_path = [ 
				`${out}/android/${project_name}/out/Release/CMakeLists.txt`,
				`${out}/android/${project_name}/out/Debug/CMakeLists.txt`,
			];
			proj_out = path.relative(source, `${out}/android/${project_name}`);
		} else {
			throw `Not Supported "${os}" export`;
		}

		// write _var.gypi
		var include_gypi = ' -Iout/_var.gypi';
		var var_gyp = { variables: { OS: os, os: os, project: project } };
		fs.writeFileSync(source + '/out/_var.gypi', JSON.stringify(var_gyp, null, 2));

		paths.includes_gypi.forEach(function(str) { 
			include_gypi += ' -I' + path.relative(source, str);
		});

		var shell = `\
			GYP_GENERATORS=${project} ${gyp_exec} \
			-f ${project} \
			--generator-output="${proj_out}" \
			-Goutput_dir="${path.relative(source,out)}" \
			-Gstandalone ${include_gypi} \
			${project_name}.gyp \
			--depth=. \
		`;

		var buf = child_process.execSync(shell);

		if ( buf.length ) {
			console.log(buf.toString());
		}

		return project_path;
	}

	private export_result() {
		var self = this;
		// write gyp

		var source = self.source;
		var includes = [];

		for ( var i in self.outputs ) {
			var pkg = self.outputs[i];
			if ( !pkg.is_app ) { // node_modules
				fs.writeFileSync( pkg.gypi_path, JSON.stringify(pkg.gen(), null, 2));
			}
		}

		for ( var i in self.outputs ) {
			var pkg = self.outputs[i];
			if ( pkg.is_app ) {
				includes.push(...pkg.includes, pkg.gypi_path);
			}
		}

		includes = filter_repeat(includes).map(function(pathname) {
			return path.relative(source, pathname);
		});

		var ngui_gyp = paths.ngui_gyp;
		var gyp = 
		{
			'variables': {
				'libngui': [ ngui_gyp ? path.relative(source, ngui_gyp) + ':libngui': 'libngui' ],
			},
			'includes': includes,
		};

		var project_name = self.m_project_name;
		var gyp_file = source + '/' + project_name +'.gyp';

		// write gyp file
		fs.writeFileSync( gyp_file, JSON.stringify(gyp, null, 2) ); 
		var out = self.gen_project_file(project_name); // gen target project 

		try {
			if (process.platform == 'darwin') {
				child_process.execSync('open ' + out[0]); // open project
			} else {
				child_process.execSync('xdg-open ' + out[0]); // open project
			}
		} catch (e) {
			// 
		}

		fs.removerSync(gyp_file); // write gyp file

		console.log('export complete');
	}

	private write_cmake_depe_to_android_build_gradle(pkg: Package, cmake: string, add: boolean) {
		var self = this;
		var build_gradle = `${self.proj_out}/${pkg.name}/build.gradle`;
		var str = fs.readFileSync(build_gradle).toString('utf8');
		str = str.replace(/^.*android\.externalNativeBuild\.cmake\.path\s*=\s*("|')[^"']*("|').*$/mg, '');
		cmake = path.relative(`${self.proj_out}/${pkg.name}`, cmake);
		cmake = `android.externalNativeBuild.cmake.path = '${cmake}'`;
		if ( add ) {
			str += cmake;
		}
		fs.writeFileSync(build_gradle, str);
	}

	private export_result_android() {
		var self = this;
		// write gyp
		var output = self.output;
		var proj_out = self.proj_out;
		var settings_gradle = [];
		var use_ndk = false;
		var source = self.source;
		var str: string;

		for ( var i in self.outputs ) {
			var pkg = self.outputs[i];
			if ( !pkg.is_app ) { // node_modules
				fs.writeFileSync( pkg.gypi_path, JSON.stringify(pkg.gen(), null, 2));
			} else {
				if ( pkg.native )
					use_ndk = true;
				settings_gradle.push("':" + i + "'");
			}
		}

		// gen gyp and native cmake
		// android 每个项目需单独创建`gyp`并生成`.cmake`
		for ( var i in self.outputs ) {
			var pkg = self.outputs[i];
			if ( pkg.is_app ) {

				if ( pkg.native ) {
					// android并不完全依赖`gyp`,只需针对native项目生成.cmake文件

					var includes = pkg.includes.concat(pkg.gypi_path).map(function(pathname) {
						return path.relative(source, pathname);
					});
					var ngui_gyp = paths.ngui_gyp;
					var gyp = 
					{
						'variables': {
							'libngui': [ ngui_gyp ? path.relative(source, ngui_gyp) + ':libngui': 'libngui' ],
						},
						'includes': includes,
					};

					var gyp_file = source + '/' + pkg.name +'.gyp';

					// write gyp file
					fs.writeFileSync( gyp_file, JSON.stringify(gyp, null, 2) ); 
					// gen cmake
					var out = self.gen_project_file(pkg.name); // gen target project 

					fs.removerSync(gyp_file); // write gyp file

					//对于android这两个属性会影响输出库.so的默认路径,导致无法捆绑.so库文件,所以从文件中删除它
					//set_target_properties(examples PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${builddir}/pkg.${TOOLSET}")
					//set_source_files_properties(${builddir}/pkg.${TOOLSET}/pkgexamples.so PROPERTIES GENERATED "TRUE")
					var reg0 = /^set_target_properties\([^ ]+ PROPERTIES LIBRARY_OUTPUT_DIRECTORY [^\)]+\)/mg;
					var reg1 = /^set_source_files_properties\([^ ]+ PROPERTIES GENERATED "TRUE"\)/mg;
					out.forEach(function(cmake) {
						str = fs.readFileSync(cmake).toString('utf8');
						str = str.replace(reg0, '').replace(reg1, '');
						fs.writeFileSync(cmake, str);
					});
	
					// write CMakeLists.txt path
					self.write_cmake_depe_to_android_build_gradle(pkg, out[0], true);
				} else {
					self.write_cmake_depe_to_android_build_gradle(pkg, '', false);
				}

				// copy pkgrary bundle resources to android assets directory
				var android_assets = `${proj_out}/${pkg.name}/src/main/assets`;

				pkg.bundle_resources.forEach(function(res) {
					var basename = path.basename(res);
					var source = path.relative(android_assets, output + '/' + res);
					if (!fs.existsSync(output + '/' + res))
						return;
					var target = `${android_assets}/${basename}`;
					try {
						// if ( fs.existsSync(target) )
						fs.unlinkSync(target);
					} catch(e) {}
					fs.symlinkSync(source, target);
				});
			}
		}

		// write settings.gradle
		fs.writeFileSync(proj_out + '/settings.gradle', 'include ' + settings_gradle.join(','));
		// set useDeprecatedNdk from gradle.properties
		str = fs.readFileSync(proj_out + '/gradle.properties').toString('utf8');
		str = str.replace(/useDeprecatedNdk\s*=\s*(false|true)/, function(){ 
			return `useDeprecatedNdk=${use_ndk}` 
		});
		fs.writeFileSync(proj_out + '/gradle.properties', str);

		try {
			if (process.platform == 'darwin') {
				// open project
				if (fs.existsSync('/Applications/Android Studio.app')) { // check is install 'Android Studio'
					child_process.execSync('open -a "/Applications/Android Studio.app" Project/android');
				} else {
					child_process.execSync('open Project/android'); // open project
				}
			} else {
				child_process.exec('xdg-open Project/android'); // open project
				setTimeout(e=>process.exit(0),1e3); // force exit
			}
		} catch (e) {
			// 
		}
		console.log('Export Ok');
	}

	private exists(name: string) {
		return fs.existsSync(this.output + '/install/' + name) || fs.existsSync(this.output + '/skip_install/' + name)
	}

	async export() {
		var self = this;
		var os = this.os;
		var keys_path = self.source + '/proj.keys';

		util.assert(
			os == 'android' || 
			os == 'ios', 'Do not support {0} os export', os);

		util.assert(fs.existsSync(keys_path), 'Proj.keys file not found');

		var proj = keys.parseFile( keys_path );
		var apps = [];

		for (var key in proj) {
			if ( key == '@projectName' ) {
				this.m_project_name = proj['@projectName'];
			} else if (key == '@apps') {
				for (var app in proj['@apps']) {
					apps.push(app);
				}
			}
		}

		// build apps
		for (var app of apps) {
			if ( !self.exists(app) )
				await (new NguiBuild(this.source, this.output).build());
		}

		// export node_modules
		var node_modules = self.source + '/node_modules';

		if ( fs.existsSync(node_modules) && fs.statSync(node_modules).isDirectory() ) {
			fs.listSync(node_modules).forEach(function(stat) {
				var source = node_modules + '/' + stat.name;
				if ( stat.isDirectory() && fs.existsSync(source + '/package.json') ) {
					self.solve(source, false);
				}
			});
		}

		// export apps
		for (var app of apps) {
			util.assert(self.exists(app), 'Installation directory not found');
			self.solve(this.source + '/' + app, true);
		}

		if ( os == 'android' ) {
			self.export_result_android();
		} else {
			self.export_result();
		}
	}

}