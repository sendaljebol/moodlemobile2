// (C) Copyright 2015 Martin Dougiamas
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

angular.module('mm.core.course')

.constant('mmCoreCourseModulesStore', 'course_modules')

.config(function($mmSitesFactoryProvider, mmCoreCourseModulesStore) {
    var stores = [
        {
            name: mmCoreCourseModulesStore,
            keyPath: 'id'
        }
    ];
    $mmSitesFactoryProvider.registerStores(stores);
})

/**
 * Factory containing course related methods.
 *
 * @module mm.core.course
 * @ngdoc service
 * @name $mmCourse
 */
.factory('$mmCourse', function($mmSite, $mmSitesManager, $translate, $q, $log, $mmFilepool, $mmEvents, mmCoreCourseModulesStore,
            mmCoreEventCompletionModuleViewed, mmCoreDownloaded, mmCoreDownloading, mmCoreNotDownloaded, mmCoreOutdated,
            mmCoreNotDownloadable, mmCoreCourseModuleStatusChanged) {

    $log = $log.getInstance('$mmCourse');

    var self = {},
        mods = ["assign", "assignment", "book", "chat", "choice", "data", "database", "date", "external-tool",
            "feedback", "file", "folder", "forum", "glossary", "ims", "imscp", "label", "lesson", "lti", "page", "quiz",
            "resource", "scorm", "survey", "url", "wiki", "workshop"
        ];

    /**
     * Check if module completion could have changed. If it could have, trigger event. This function must be used,
     * for example, after calling a "module_view" WS since it can change the module completion.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#checkModuleCompletion
     * @param {Number} courseId   Course ID.
     * @param {Object} completion Completion status of the module.
     */
    self.checkModuleCompletion = function(courseId, completion) {
        if (completion && completion.tracking === 2 && completion.state === 0) {
            self.invalidateSections(courseId).finally(function() {
                $mmEvents.trigger(mmCoreEventCompletionModuleViewed, courseId);
            });
        }
    };

    /**
     * Clear all modules status in a site.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#clearAllModulesStatus
     * @param {String} siteId Site ID.
     * @return {Promise}      Promise resolved when all status are cleared.
     */
    self.clearAllModulesStatus = function(siteId) {
        var promises = [];
        $log.debug('Clear all module status for site ' + siteId);
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();
            return db.getAll(mmCoreCourseModulesStore).then(function(entries) {
                angular.forEach(entries, function(entry) {
                    promises.push(db.remove(mmCoreCourseModulesStore, entry.id).then(function() {
                        // Trigger module status changed, setting it as not downloaded.
                        $mmEvents.trigger(mmCoreCourseModuleStatusChanged,
                            {siteid: siteId, moduleid: entry.id, status: mmCoreNotDownloaded});
                    }));
                });
                return $q.all(promises);
            });
        });
    };

    /**
     * Given the current status of a list of modules and the status of one of the modules,
     * determine the new status for the list of modules. The status of a list of modules is:
     *     - mmCoreNotDownloadable if there are no downloadable modules.
     *     - mmCoreNotDownloaded if at least 1 module has status mmCoreNotDownloaded.
     *     - mmCoreDownloaded if ALL the downloadable modules have status mmCoreDownloaded.
     *     - mmCoreDownloading if ALL the downloadable modules have status mmCoreDownloading or mmCoreDownloaded,
     *                                     with at least 1 module with mmCoreDownloading.
     *     - mmCoreOutdated if ALL the downloadable modules have status mmCoreOutdated or mmCoreDownloaded or
     *                                     mmCoreDownloading, with at least 1 module with mmCoreOutdated.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#determineModulesStatus
     * @param {String} current       Current status of the list of modules
     * @param {String} modulestatus  Status of one of the modules.
     * @return {String}              New status for the list of modules;
     */
    self.determineModulesStatus = function(current, modulestatus) {
        if (!current) {
            current = mmCoreNotDownloadable;
        }

        if (modulestatus === mmCoreNotDownloaded) {
            // If 1 module is not downloaded the status of the whole list will always be not downloaded.
            return mmCoreNotDownloaded;
        } else if (modulestatus === mmCoreDownloaded && current === mmCoreNotDownloadable) {
            // If all modules are downloaded or not downloadable with at least 1 downloaded, status will be downloaded.
            return mmCoreDownloaded;
        } else if (modulestatus === mmCoreDownloading && (current === mmCoreNotDownloadable || current === mmCoreDownloaded)) {
            // If all modules are downloading/downloaded/notdownloadable with at least 1 downloading, status will be downloading.
            return mmCoreDownloading;
        } else if (modulestatus === mmCoreOutdated && status !== mmCoreNotDownloaded) {
            // If there are no modules notdownloaded and there is at least 1 outdated, status will be outdated.
            return mmCoreOutdated;
        }

        // Status remains the same.
        return current;
    };

    /**
     * Get completion status of all the activities in a course for a certain user.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getActivitiesCompletionStatus
     * @param  {Number} courseid Course ID.
     * @param  {Number} [userid] User ID. If not defined, current user.
     * @return {Promise}         Promise resolved with the completion statuses: object where the key is module ID.
     */
    self.getActivitiesCompletionStatus = function(courseid, userid) {
        userid = userid || $mmSite.getUserId();

        $log.debug('Getting completion status for user ' + userid + ' in course ' + courseid);

        var params = {
                courseid: courseid,
                userid: userid
            },
            preSets = {
                cacheKey: getActivitiesCompletionCacheKey(courseid, userid)
            };

        return $mmSite.read('core_completion_get_activities_completion_status', params, preSets).then(function(data) {
            if (data && data.statuses) {
                var formattedStatuses = {};
                angular.forEach(data.statuses, function(status) {
                    formattedStatuses[status.cmid] = status;
                });
                return formattedStatuses;
            }
            return $q.reject();
        });
    };

    /**
     * Get cache key for activities completion WS calls.
     *
     * @param  {Number} courseid Course ID.
     * @param  {Number} userid   User ID.
     * @return {String}          Cache key.
     */
    function getActivitiesCompletionCacheKey(courseid, userid) {
        return 'mmCourse:activitiescompletion:' + courseid + ':' + userid;
    }

    /**
     * Get a module from Moodle.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getModule
     * @param {Number} courseid    The course ID.
     * @param {Number} moduleid    The module ID.
     * @param {Number} [sectionid] The section ID.
     * @return {Promise}
     */
    self.getModule = function(courseid, moduleid, sectionid) {

        if (!moduleid) {
            return $q.reject();
        }

        $log.debug('Getting module ' + moduleid + ' in course ' + courseid + ' and section ' +sectionid);

        var params = {
                courseid: courseid,
                options: [
                    {
                        name: 'cmid',
                        value: moduleid
                    }
                ]
            },
            preSets = {
                cacheKey: getModuleCacheKey(moduleid)
            };

        if (sectionid) {
            params.options.push({
                name: 'sectionid',
                value: sectionid
            });
        }

        return $mmSite.read('core_course_get_contents', params, preSets).then(function(sections) {
            var section,
                module;

            for (var i = 0; i < sections.length; i++) {
                section = sections[i];
                for (var j = 0; j < section.modules.length; j++) {
                    module = section.modules[j];
                    if (module.id === moduleid) {
                        return module;
                    }
                }
            }

            return $q.reject();
        });
    };

    /**
     * Get cache key for module WS calls.
     *
     * @param {Number} moduleid Module ID.
     * @return {String}         Cache key.
     */
    function getModuleCacheKey(moduleid) {
        return 'mmCourse:module:' + moduleid;
    }

    /**
     * Returns the source to a module icon.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getModuleIconSrc
     * @param {String} moduleName The module name.
     * @return {String} The IMG src.
     */
    self.getModuleIconSrc = function(moduleName) {
        if (mods.indexOf(moduleName) < 0) {
            moduleName = "external-tool";
        }

        return "img/mod/" + moduleName + ".svg";
    };

    /**
     * Get a module previous status.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getModulePreviousStatus
     * @param {String} siteId Site ID.
     * @param {Number} id     Module ID.
     * @return {Promise}      Promise resolved with the status.
     */
    self.getModulePreviousStatus = function(siteId, id) {
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();
            return db.get(mmCoreCourseModulesStore, id).then(function(module) {
                return module.previous || mmCoreNotDownloaded;
            }, function() {
                return mmCoreNotDownloaded;
            });
        });
    };

    /**
     * Get a module status.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getModuleStatus
     * @param {String} siteId           Site ID.
     * @param {Number} id               Module ID.
     * @param {Number} [revision=0]     Module's revision.
     * @param {Number} [timemodified=0] Module's timemodified.
     * @return {Promise}                Promise resolved with the status.
     */
    self.getModuleStatus = function(siteId, id, revision, timemodified) {
        revision = revision || 0;
        timemodified = timemodified || 0;
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();
            return db.get(mmCoreCourseModulesStore, id).then(function(module) {
                if (module.status === mmCoreDownloaded) {
                    if (revision > module.revision || timemodified > module.timemodified) {
                        // File is outdated. Let's change its status.
                        module.status = mmCoreOutdated;
                        module.updated = new Date().getTime();
                        db.insert(mmCoreCourseModulesStore, module).then(function() {
                            $mmEvents.trigger(mmCoreCourseModuleStatusChanged,
                                {siteid: siteId, moduleid: id, status: mmCoreOutdated});
                        });
                    }
                }
                return module.status;
            }, function() {
                return mmCoreNotDownloaded;
            });
        });
    };

    /**
     * Get module revision number from contents.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getRevisionFromContents
     * @param {Object[]} contents Module contents.
     * @return {Number}           Module revision.
     */
    self.getRevisionFromContents = function(contents) {
        if (contents && contents.length) {
            for (var i = 0; i < contents.length; i++) {
                var file = contents[i];
                if (file.fileurl) {
                    var revision = $mmFilepool.getRevisionFromUrl(file.fileurl);
                    if (typeof revision !== 'undefined') {
                        return revision;
                    }
                }
            }
        }
        return 0;
    };

    /**
     * Return a specific section.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getSection
     * @param {Number} courseid The course ID.
     * @param {Number} sectionid The section ID.
     * @return {Promise} The reject contains the error message, else contains the section.
     */
    self.getSection = function(courseid, sectionid) {
        var deferred = $q.defer();

        if (sectionid < 0) {
            deferred.reject('Invalid section ID');
            return deferred.promise;
        }

        self.getSections(courseid).then(function(sections) {
            for (var i = 0; i < sections.length; i++) {
                if (sections[i].id == sectionid) {
                    deferred.resolve(sections[i]);
                    return;
                }
            }
            deferred.reject('Unkown section');
        }, function(error) {
            deferred.reject(error);
        });

        return deferred.promise;
    };

    /**
     * Get the course sections.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getSections
     * @param {Number} courseid The course ID.
     * @return {Promise} The reject contains the error message, else contains the sections.
     */
    self.getSections = function(courseid) {
        var presets = {
            cacheKey: getSectionsCacheKey(courseid)
        };
        return $mmSite.read('core_course_get_contents', {
            courseid: courseid,
            options: []
        }, presets);
    };

    /**
     * Get cache key for section WS call.
     *
     * @param  {Number} courseid Course ID.
     * @return {String}          Cache key.
     */
    function getSectionsCacheKey(courseid) {
        return 'mmCourse:sections:' + courseid;
    }

    /**
     * Get module timemodified from contents.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#getTimemodifiedFromContents
     * @param {Object[]} contents Module contents.
     * @return {Number}           Module timemodified.
     */
    self.getTimemodifiedFromContents = function(contents) {
        if (contents && contents.length) {
            for (var i = 0; i < contents.length; i++) {
                var file = contents[i];
                if (file.timemodified) {
                    return file.timemodified;
                }
            }
        }
        return 0;
    };

    /**
     * Invalidates module WS call.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#invalidateModule
     * @param {Number} moduleid Module ID.
     * @return {Promise}        Promise resolved when the data is invalidated.
     */
    self.invalidateModule = function(moduleid) {
        return $mmSite.invalidateWsCacheForKey(getModuleCacheKey(moduleid));
    };

    /**
     * Invalidates sections WS call.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#invalidateSections
     * @param {Number} courseid  Course ID.
     * @param  {Number} [userid] User ID. If not defined, current user.
     * @return {Promise}         Promise resolved when the data is invalidated.
     */
    self.invalidateSections = function(courseid, userid) {
        userid = userid || $mmSite.getUserId();

        var p1 = $mmSite.invalidateWsCacheForKey(getSectionsCacheKey(courseid)),
            p2 = $mmSite.invalidateWsCacheForKey(getActivitiesCompletionCacheKey(courseid, userid));
        return $q.all([p1, p2]);
    };

    /**
     * Check if a module is outdated.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#isModuleOutdated
     * @param {String} siteId           Site ID.
     * @param {Number} id               Module ID.
     * @param {Number} [revision=0]     Module's revision.
     * @param {Number} [timemodified=0] Module's timemodified.
     * @return {Promise}                Promise resolved with boolean: true if module is outdated, false otherwise.
     */
    self.isModuleOutdated = function(siteId, id, revision, timemodified) {
        revision = revision || 0;
        timemodified = timemodified || 0;
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();
            return db.get(mmCoreCourseModulesStore, id).then(function(module) {
                return revision > module.revision || timemodified > module.timemodified;
            }, function() {
                return false;
            });
        });
    };

    /**
     * Change the module status, setting it to the previous status.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#setModulePreviousStatus
     * @param {String} siteId Site ID.
     * @param {Number} id     Module ID.
     * @return {Promise}      Promise resolved when the status is changed. Resolve param: new status.
     */
    self.setModulePreviousStatus = function(siteId, id) {
        $log.debug('Set previous status for module ' + id);
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();

            // Get current stored data, we'll only update 'status' and 'updated' fields.
            return db.get(mmCoreCourseModulesStore, id).then(function(module) {
                module.status = module.previous || mmCoreNotDownloaded;
                module.updated = new Date().getTime();
                $log.debug('Set status \'' + module.status + '\' for module ' + id);

                return db.insert(mmCoreCourseModulesStore, module).then(function() {
                    $mmEvents.trigger(mmCoreCourseModuleStatusChanged, {siteid: siteId, moduleid: id, status: module.status});
                    return module.status;
                });
            });
        });
    };

    /**
     * Store module status.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#storeModuleStatus
     * @param {String} siteId           Site ID.
     * @param {Number} id               Module ID.
     * @param {String} status           New module status.
     * @param {Number} [revision=0]     Module's revision.
     * @param {Number} [timemodified=0] Module's timemodified.
     * @return {Promise}                Promise resolved when status is stored.
     */
    self.storeModuleStatus = function(siteId, id, status, revision, timemodified) {
        $log.debug('Set status \'' + status + '\' for module ' + id);
        revision = revision || 0;
        timemodified = timemodified || 0;
        return $mmSitesManager.getSite(siteId).then(function(site) {
            var db = site.getDb();

            // Search current status to set it as previous status.
            return db.get(mmCoreCourseModulesStore, id).then(function(module) {
                return module.status;
            }, function() {
                return undefined;
            }).then(function(previousStatus) {
                return db.insert(mmCoreCourseModulesStore, {
                    id: id,
                    status: status,
                    previous: previousStatus,
                    revision: revision,
                    timemodified: timemodified,
                    updated: new Date().getTime()
                }).then(function(result) {
                    $mmEvents.trigger(mmCoreCourseModuleStatusChanged, {siteid: siteId, moduleid: id, status: status});
                    return result;
                });
            });
        });
    };

    /**
     * Translate a module name to current language.
     *
     * @module mm.core.course
     * @ngdoc method
     * @name $mmCourse#translateModuleName
     * @param {String} moduleName The module name.
     * @return {Promise}          Promise resolved with the translated name.
     */
    self.translateModuleName = function(moduleName) {
        if (mods.indexOf(moduleName) < 0) {
            moduleName = "external-tool";
        }

        var langkey = 'mm.core.mod_'+moduleName;
        return $translate(langkey).then(function(translated) {
            return translated !== langkey ? translated : moduleName;
        });
    };


    return self;
});
