import star.base.neo.NeoObjectVector;
import star.base.neo.NeoProperty;
import star.base.neo.StringVector;
import star.base.query.NameOperator;
import star.base.query.NamePredicate;
import star.base.query.Query;
import star.cadmodeler.*;
import star.common.*;
import star.coupledflow.*;
import star.flow.VelocityMagnitudeProfile;
import star.flow.VelocityProfile;
import star.flow.WallSlidingOption;
import star.kwturb.KwTurbConstitutiveOption;
import star.kwturb.KwTurbCurvatureCorrectionOption;
import star.kwturb.KwTurbSolver;
import star.kwturb.SstKwTurbModel;
import star.meshing.*;
import star.motion.*;
import star.prismmesher.PrismAutoMesher;
import star.resurfacer.ResurfacerAutoMesher;
import star.surfacewrapper.SurfaceWrapperAutoMeshOperation;
import star.turbulence.RealizableTimeParameter;
import star.turbulence.TurbSolver;
import star.turbulence.TurbViscositySolver;
import star.vis.SimpleAnnotation;

import java.io.*;
import java.util.Arrays;
import java.util.Collection;


// The team's meshing macro (template SCRIPT_RANS, 2025-11-13), kept in HoMo CFD with a reworked addCAD():
// CAD files in the case folder replace a part group before meshing. See starccm/README.md.
// Changes of 2026-10-14: STL files are read with STAR-CCM+'s own STL reader in millimetres (no add-on licence;
// STEP/IGES need a CAD Exchange licence, which is shared on Fritz and was not free on 2026-10-14); the contents
// of a replaced group are logged; a failed import stops the macro before meshing; an IMPORT_ONLY file in the
// case folder stops it after the import (test mode, nothing saved). A file MESHED is written after a
// successful meshing and save, so the job script can refuse to start the solver otherwise.
public class mesh extends StarMacro {

    private Simulation simulation_0;
    private String directory;
    private Units units_1, units_mm;
    private Region region_air;
    private Double rrh, frh, roll_angle, yaw, steering_angle, velocity, wheelbase;
    private Double cornering_radius, cornering_outerradius, cornering_innerradius;
    private Double rollCenter;
    private Double windtunnel_length_forward, windtunnel_length_backward, windtunnel_width, windtunnel_height;
    private String windtunnel_type, turbulence_model;
    private SolidModelCompositePart frontwing, undertray, deflectors, rearwing, monocoque, remaining;
    private Collection<SolidModelCompositePart> vehicle;
    private LabCoordinateSystem labCoordinateSystem_0;

    private PhysicsContinuum physicsContinuum;
    private String erros = "";
    private String slash = "/";

    private double hxPosX, hxPosY, hxPosZ, fanPosX, fanPosY, fanPosZ, hxAngleX, hxAngleY, hxAngleZ, fanAngleX, fanAngleY, fanAngleZ, hxWidth, hxHeight, hxThickness, fanRadius, fanThickness;


    @Override
    public void execute() {

        simulation_0 = getActiveSimulation();   //important that getActiveSimulation is not already executed in the declaration
        directory = simulation_0.getSessionDir();

        if (directory.contains("\\")) {
            slash = "\\";
        }

        units_1 =
                ((Units) simulation_0.getUnitsManager().getObject(""));
        units_mm =
                ((Units) simulation_0.getUnitsManager().getObject("mm"));

        frontwing = group("C_FRONTWING");
        undertray = group("C_UNDERTRAY");
        deflectors = group("C_UNDERTRAY_DEFLECTORS");
        rearwing = group("C_REARWING");
        monocoque = group("C_MONOCOQUE");
        remaining = group("z_000_remaining-parts");

        vehicle = new NeoObjectVector(new Object[]{frontwing, undertray, deflectors, rearwing, monocoque, remaining});
        labCoordinateSystem_0 =
                simulation_0.getCoordinateSystemManager().getLabCoordinateSystem();

        region_air =
                simulation_0.getRegionManager().getRegion("Air");


        physicsContinuum =
                ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-omegaSST"));

        File settings = new File(directory + slash + "Settings");

        try {
            addCAD();
        } catch (Exception e) {
            erros += "Adding CAD failed: " + e + "\n";
        }

        // Never mesh a simulation whose CAD swap failed: it would quietly run with the old parts.
        if (!erros.isEmpty()) {
            writeErrors();
            simulation_0.println("addCAD: import failed, meshing skipped (see ERRORS)");
            return;
        }
        if (new File(directory + slash + "IMPORT_ONLY").exists()) {
            simulation_0.println("IMPORT_ONLY: import checked; no meshing, simulation not saved");
            return;
        }

        if (settings.exists()) {
            try {
                setupSettings(settings);
            } catch (Exception e) {
                erros += "Setting settings failed \n";
            }
            try {
                setupCornering();
            } catch (Exception e) {
                erros += "Setting up cornering failed \n";
            }
            //setPosCooling();
        } else {
            for (int i = 0; i <= 50; i++) {
                simulation_0.println("NO SETTINGS FILE");
            }
        }

        File mapSettings = new File(directory + slash + "MapSettings");
        if (mapSettings.exists()) {
            try {
                setupSettings(mapSettings);
            } catch (Exception e) {
                erros += "Setting map settings failed \n";
            }
        }


        writeErrors();

        startMeshing();

    }


    private void setupSettings(File settingsFile) {
        try {
            var br = new BufferedReader(new FileReader(settingsFile));
            String line;
            while ((line = br.readLine()) != null) {
                String[] parts = line.split(" : ");
                if (parts.length > 1) {
                    String name = parts[0].trim();
                    String value = parts[1].trim();


                    if (name.startsWith("Mesh/Mesh Air/Mesher") || name.startsWith("Mesh/Mesh Air/Default Controls")) {
                        try {
                            wrapperSetSettings(name, value);
                            airSetDefaultControls(name, value);
                        } catch (Exception e) {
                            erros += "Setting mesh failed\n";
                        }
                    } else if (name.startsWith("Physics")) {
                        try {
                            physicsSetSettings(name, value);
                        } catch (Exception e) {
                            erros += "Setting physics failed\n";
                        }
                    } else if (name.startsWith("Vehicle State")) {
                        try {
                            vehicleStateSetSettings(name, value);
                        } catch (Exception e) {
                            erros += "Setting vehicle states failed\n";
                        }
                    }

                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    private void wrapperSetSettings(String name, String value) {
        SurfaceWrapperAutoMeshOperation wrapper =
                ((SurfaceWrapperAutoMeshOperation) simulation_0.get(MeshOperationManager.class).getObject("Z_Wrapper"));

        if (name.contains("Default Controls/Base Size")) {

            wrapper.getDefaultValues().get(BaseSize.class).setValueAndUnits(Double.parseDouble(value), units_mm);

        }

    }

    private void airSetDefaultControls(String name, String value) {
        AutoMeshOperation air =
                ((AutoMeshOperation) simulation_0.get(MeshOperationManager.class).getObject("air"));

        ResurfacerAutoMesher resurfacerAir =
                ((ResurfacerAutoMesher) air.getMeshers().getObject("Surface Remesher"));
        PrismAutoMesher prismAutoMesher_0 =
                ((PrismAutoMesher) air.getMeshers().getObject("Prism Layer Mesher"));

        if (name.equals("Mesh/Mesh Air/Mesher/Mesher")) {
            if (value.equals("Trimmed")) {
                air.getMeshers().setMeshersByNames(new StringVector(new String[]{"star.resurfacer.ResurfacerAutoMesher", "star.trimmer.TrimmerAutoMesher", "star.prismmesher.PrismAutoMesher", "star.resurfacer.AutomaticSurfaceRepairAutoMesher"}));
            } else if (value.equals("Poly")) {
                air.getMeshers().setMeshersByNames(new StringVector(new String[]{"star.resurfacer.ResurfacerAutoMesher", "star.dualmesher.DualAutoMesher", "star.prismmesher.PrismAutoMesher", "star.resurfacer.AutomaticSurfaceRepairAutoMesher"}));
            }
        } else if (name.equals("Mesh/Mesh Air/Default Controls/Base Size")) {
            air.getDefaultValues().get(BaseSize.class).setValueAndUnits(Double.parseDouble(value), units_mm);
        } else if (name.equals("Mesh/Mesh Air/Default Controls/CAD Projection")) {
            ProjectToCadOption projectToCadOption_1 =
                    air.getDefaultValues().get(ProjectToCadOption.class);
            projectToCadOption_1.setProjectToCad(Boolean.parseBoolean(value));
        } else if (name.equals("Mesh/Mesh Air/Default Controls/Target Surface Size")) {
            PartsTargetSurfaceSize partsTargetSurfaceSize_2 =
                    air.getDefaultValues().get(PartsTargetSurfaceSize.class);

            partsTargetSurfaceSize_2.getRelativeSizeScalar().setValueAndUnits(Double.parseDouble(value), units_1);
        }
    }

    private void physicsSetSettings(String name, String value) {
        region_air =
                simulation_0.getRegionManager().getRegion("Air");


        //PhysicsContinuum physicsContinuum =
        //       ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-omegaSST"));
        //physicsContinuum.add(region_air);


        if (value.equals("k-omegaSST")) {
            physicsContinuum =
                    ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-omegaSST"));
            turbulence_model = value;

        } else if (value.equals("k-epsilon Lag EB")) {
            physicsContinuum =
                    ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-epsilon Lag EB"));
            turbulence_model = value;

        } else if (value.equals("k-epsilon Realizable TL")) {
            physicsContinuum =
                    ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-epsilon Realizable TL"));
            turbulence_model = value;
        } else if (value.equals("Reynolds Stress Model")) {
            physicsContinuum =
                    ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("Reynolds Stress Model"));
            turbulence_model = value;
        } else if (value.equals("DES")) {
            physicsContinuum =
                    ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("DES"));
            turbulence_model = value;
        }

        if (name.contains("a1")) {
            SstKwTurbModel sstKwTurbModel =
                    physicsContinuum.getModelManager().getModel(SstKwTurbModel.class);

            sstKwTurbModel.setA1(Double.parseDouble(value));
        } else if (name.contains("Realizability Coefficient")) {

            SstKwTurbModel sstKwTurbModel =
                    physicsContinuum.getModelManager().getModel(SstKwTurbModel.class);

            RealizableTimeParameter realizableTimeParameter_0 =
                    sstKwTurbModel.getRealizableTimeParameter();

            realizableTimeParameter_0.setRealizableTimeCoefficient(Double.parseDouble(value));
        } else if (name.contains("Constitutive Option")) {

            SstKwTurbModel sstKwTurbModel =
                    physicsContinuum.getModelManager().getModel(SstKwTurbModel.class);
            if (value.equals("Linear")) {
                sstKwTurbModel.getKwTurbConstitutiveOption().setSelected(KwTurbConstitutiveOption.Type.LINEAR);
            } else if (value.equals("Quadratic")) {
                sstKwTurbModel.getKwTurbConstitutiveOption().setSelected(KwTurbConstitutiveOption.Type.QCR);
            } else if (value.equals("Cubic")) {
                sstKwTurbModel.getKwTurbConstitutiveOption().setSelected(KwTurbConstitutiveOption.Type.CUBIC);
            }
        } else if (name.contains("Curvature Correction")) {

            SstKwTurbModel sstKwTurbModel =
                    physicsContinuum.getModelManager().getModel(SstKwTurbModel.class);
            if (value.equals("true")) {
                sstKwTurbModel.getKwTurbCurvatureCorrectionOption().setSelected(KwTurbCurvatureCorrectionOption.Type.DURBIN);
            } else {
                sstKwTurbModel.getKwTurbCurvatureCorrectionOption().setSelected(KwTurbCurvatureCorrectionOption.Type.OFF);
            }
        }

        physicsContinuum.add(region_air);

        if (name.contains("Solver") && !turbulence_model.equals("DES")) {
            CoupledImplicitSolver coupledImplicitSolver_0 =
                    ((CoupledImplicitSolver) simulation_0.getSolverManager().getSolver(CoupledImplicitSolver.class));

            if (name.contains("Explicit Relaxiation Factor")) {
                ExplicitRelaxationController explicitRelaxationController_0 =
                        coupledImplicitSolver_0.getExplicitRelaxationController();

                ConstantExplicitRelaxationControl constantExplicitRelaxationControl_0 =
                        ((ConstantExplicitRelaxationControl) explicitRelaxationController_0.getExplicitRelaxationControl());

                constantExplicitRelaxationControl_0.getUrfQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } else if (name.contains("Max Auto CFL")) {
                CourantNumberController courantNumberController_0 =
                        coupledImplicitSolver_0.getCourantNumberController();

                AutomaticCourantNumberControl automaticCourantNumberControl_0 =
                        ((AutomaticCourantNumberControl) courantNumberController_0.getCourantNumberControl());

                automaticCourantNumberControl_0.setCFLMaximumValue(Double.parseDouble(value));
            } else if (name.contains("Turbulence URF")) {
                TurbSolver turbSolver = (TurbSolver) simulation_0.getSolverManager().getSolver(KwTurbSolver.class);

                turbSolver.getUrfQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } else if (name.contains("Turbulence Viscosity URF")) {
                TurbViscositySolver turbViscositySolver = (TurbViscositySolver) simulation_0.getSolverManager().getSolver(TurbViscositySolver.class);

                turbViscositySolver.getViscosityUrfQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            }


        }


    }


    private void setupCornering() {

        PhysicsContinuum activePhysicsContinuum =
                ((PhysicsContinuum) region_air.getPhysicsContinuum());

        VelocityProfile velocityProfile_3 =
                activePhysicsContinuum.getInitialConditions().get(VelocityProfile.class);

        Units units_vel =
                ((Units) simulation_0.getUnitsManager().getObject("m/s"));

        if (windtunnel_type.equals("Cornering")) {
            velocityProfile_3.getMethod(ConstantVectorProfileMethod.class).getQuantity().setComponentsAndUnits(0.0, 0.0, 0.0, units_vel);
        } else {
            velocityProfile_3.getMethod(ConstantVectorProfileMethod.class).getQuantity().setDefinition("[-${u_inlet}, 0.0, 0.0]");
        }


        Boundary boundary_7 =
                region_air.getBoundaryManager().getBoundary("floor");

        if (windtunnel_type.equals("Cornering")) {
            boundary_7.getConditions().get(WallReferenceFrameOption.class).setSelected(ReferenceFrameOption.Type.LAB_FRAME);

            boundary_7.getConditions().get(WallSlidingOption.class).setSelected(WallSlidingOption.Type.FIXED);
        } else {
            boundary_7.getConditions().get(WallReferenceFrameOption.class).setSelected(ReferenceFrameOption.Type.REGION_FRAME);

            boundary_7.getConditions().get(WallSlidingOption.class).setSelected(WallSlidingOption.Type.VECTOR);
        }


        ScalarGlobalParameter scalarGlobalParameter_0 =
                ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("Reference Area"));

        Units units_2 =
                ((Units) simulation_0.getUnitsManager().getObject("m^2"));

        if (windtunnel_type.equals("Half-Car")) {
            scalarGlobalParameter_0.getQuantity().setValueAndUnits(0.5, units_2);
        } else {
            scalarGlobalParameter_0.getQuantity().setValueAndUnits(1.0, units_2);
        }


        MotionSpecification motionSpecification_0 =
                region_air.getValues().get(MotionSpecification.class);

        if (windtunnel_type.equals("Cornering")) {
            UserRotatingReferenceFrame userRotatingReferenceFrame_0 =
                    ((UserRotatingReferenceFrame) simulation_0.get(ReferenceFrameManager.class).getObject("windtunnel_rotation"));

            motionSpecification_0.setReferenceFrame(userRotatingReferenceFrame_0);
        } else {
            LabReferenceFrame labReferenceFrame_0 =
                    ((LabReferenceFrame) simulation_0.get(ReferenceFrameManager.class).getObject("Lab Reference Frame"));

            motionSpecification_0.setReferenceFrame(labReferenceFrame_0);
        }

        Boundary boundary_8 =
                region_air.getBoundaryManager().getBoundary("inlet");

        VelocityMagnitudeProfile velocityMagnitudeProfile_0 =
                boundary_8.getValues().get(VelocityMagnitudeProfile.class);

        Units units_0 =
                ((Units) simulation_0.getUnitsManager().getObject("m/s"));

        if (windtunnel_type.equals("Cornering")) {
            //StagnationBoundary stagnationBoundary_0 =
            //((StagnationBoundary) simulation_0.get(ConditionTypeManager.class).get(StagnationBoundary.class));

            //boundary_8.setBoundaryType(stagnationBoundary_0);

            velocityMagnitudeProfile_0.getMethod(ConstantScalarProfileMethod.class).getQuantity().setValueAndUnits(0.0, units_0);

        } else {
            //InletBoundary inletBoundary_0 =
            //((InletBoundary) simulation_0.get(ConditionTypeManager.class).get(InletBoundary.class));

            //boundary_8.setBoundaryType(inletBoundary_0);

            velocityMagnitudeProfile_0.getMethod(ConstantScalarProfileMethod.class).getQuantity().setDefinition("${u_inlet}");

        }

        PhysicsContinuum physicsContinuum_1 =
                ((PhysicsContinuum) region_air.getPhysicsContinuum());

        Region[] regions = new Region[4];
        regions[0] =
                simulation_0.getRegionManager().getRegion("MRF-FL");
        regions[1] =
                simulation_0.getRegionManager().getRegion("MRF-RL");
        regions[2] =
                simulation_0.getRegionManager().getRegion("MRF-FR");
        regions[3] =
                simulation_0.getRegionManager().getRegion("MRF-RR");


        for (Region deleteInterface : regions)
            try {
                BoundaryInterface boundaryInterface_0 =
                        ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Air/" + deleteInterface.getPresentationName()));

                simulation_0.getInterfaceManager().deleteInterfaces(boundaryInterface_0);
            } catch (Exception e) {

            }

        for (int i = 0; i <= 3; i++) {
            physicsContinuum_1.add(regions[i]);

        }

        if (windtunnel_type.equals("Half-Car")) {
            physicsContinuum_1.erase(regions[2]);
            physicsContinuum_1.erase(regions[3]);
            for (int i = 0; i <= 1; i++) {
                BoundaryInterface boundaryInterface_1 =
                        simulation_0.getInterfaceManager().createBoundaryInterface(region_air, regions[i], "Air/" + regions[i].getPresentationName());

                boundaryInterface_1.setResetOnRelativeMotion(false);

                boundaryInterface_1.setCloseOnFixedSide(false);

                boundaryInterface_1.getContacts().setQuery(new Query(new NamePredicate(NameOperator.Contains, ""), Query.STANDARD_MODIFIERS));
            }
        } else {
            for (int i = 0; i <= 3; i++) {
                BoundaryInterface boundaryInterface_1 =
                        simulation_0.getInterfaceManager().createBoundaryInterface(region_air, regions[i], "Air/" + regions[i].getPresentationName());

                boundaryInterface_1.setResetOnRelativeMotion(false);

                boundaryInterface_1.setCloseOnFixedSide(false);

                boundaryInterface_1.getContacts().setQuery(new Query(new NamePredicate(NameOperator.Contains, ""), Query.STANDARD_MODIFIERS));
            }
        }


        if (windtunnel_type.equals("Cornering")) {

            for (int i = 0; i <= 3; i++) {
                MotionSpecification motionSpecification_mrf =
                        regions[i].getValues().get(MotionSpecification.class);

                UserRotatingReferenceFrame userRotatingReferenceFrame_mrf =
                        ((UserRotatingReferenceFrame) simulation_0.get(ReferenceFrameManager.class).getObject("windtunnel_rotation"));

                RotatingRelativeFrame rotatingRelativeFrame_mrf =
                        ((RotatingRelativeFrame) userRotatingReferenceFrame_mrf.getRelativeReferenceFrameManager().getObject(regions[i].getPresentationName().split("-")[1]));

                motionSpecification_mrf.setReferenceFrame(rotatingRelativeFrame_mrf);
            }

        } else {


            for (int i = 0; i <= 3; i++) {

                try {
                    MotionSpecification motionSpecification_mrf =
                            regions[i].getValues().get(MotionSpecification.class);


                    UserRotatingReferenceFrame userRotatingReferenceFrame_mrf =
                            ((UserRotatingReferenceFrame) simulation_0.get(ReferenceFrameManager.class).getObject(regions[i].getPresentationName().split("-")[1]));

                    motionSpecification_mrf.setReferenceFrame(userRotatingReferenceFrame_mrf);
                } catch (Exception e) {
                }

            }


        }

    }

    private void vehicleStateSetSettings(String name, String value) {
        if (name.equals("Vehicle State/RRH")) {
            try {
                rrh = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("RRH"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(rrh, units_mm);
            } catch (Exception e) {
                erros += "Setting RRH failed \n";
            }
        } else if (name.equals("Vehicle State/FRH")) {
            try {
                frh = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("FRH"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(frh, units_mm);
            } catch (Exception e) {
                erros += "Setting FRH failed \n";
            }
        } else if (name.equals("Vehicle State/Velocity")) {
            try {
                velocity = Double.parseDouble(value);
                Units units_vel =
                        ((Units) simulation_0.getUnitsManager().getObject("m/s"));

                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("u_inlet"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(Double.parseDouble(value) / 3.6, units_vel);
            } catch (Exception e) {
                erros += "Setting Velocity failed \n";
            }
        } else if (name.equals("Vehicle State/yaw")) {
            try {
                yaw = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("Yaw"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } catch (Exception e) {
                erros += "Setting yaw angle failed \n";
            }
        } else if (name.equals("Vehicle State/Steer Angle")) {
            try {
                steering_angle = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("Steer Angle Deg"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } catch (Exception e) {
                erros += "Setting steering angle failed \n";
            }
        } else if (name.equals("Vehicle State/Roll Angle")) {
            try {
                roll_angle = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("rollAngleDeg"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(roll_angle, units_1);
            } catch (Exception e) {
                erros += "Setting roll angle failed \n";
            }
        } else if (name.equals("Vehicle State/Roll Center")) {
            try {
                rollCenter = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("Roll Center"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(rollCenter, units_mm);
            } catch (Exception e) {
                erros += "Setting roll center failed \n";
            }
        } else if (name.equals("Vehicle State/Wheelbase")) {
            try {
                wheelbase = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("wheelbase"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(wheelbase, units_mm);
            } catch (Exception e) {
                erros += "Setting wheelbase failed \n";
            }
        } else if (name.equals("Vehicle State/Tire Sockel Height")) {
            try {
                ScalarGlobalParameter scalarGlobalParameter_0 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("tire_sockel_height"));

                scalarGlobalParameter_0.getQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } catch (Exception e) {
                erros += "Setting tire sockel height failed \n";
            }

        } else if (name.equals("Vehicle State/Tire Squish Depth")) {
            try {
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("tire_suqish_depth"));

                scalarGlobalParameter_1.getQuantity().setValueAndUnits(Double.parseDouble(value), units_1);
            } catch (Exception e) {
                erros += "Setting tire squish depth failed \n";
            }

        } else if (name.equals("Vehicle State/Windtunnel/Type")) {
            try {
                windtunnel_type = value;
                SimpleBlockPart road_tunnel =
                        ((SimpleBlockPart) simulation_0.get(SimulationPartManager.class).getPart("t_open-road-tunnel"));
                SolidModelPart cornering_tunnel =
                        ((SolidModelPart) simulation_0.get(SimulationPartManager.class).getPart("t_open-cornering"));
                simulation_0.get(TagManager.class).setTags(cornering_tunnel, new NeoObjectVector(new Object[]{}));

                UserTag userTag_0 =
                        ((UserTag) simulation_0.get(TagManager.class).getObject("Wrapper"));

                simulation_0.get(TagManager.class).setTags(road_tunnel, new NeoObjectVector(new Object[]{userTag_0}));
                if (windtunnel_type.equals("Half-Car")) {
                    road_tunnel.getCorner1().setDefinition("[-${windtunnel_lengthToOutlet}, 0.0 , 0.0]");

                } else if (windtunnel_type.equals("Full-Car")) {
                    Solution solution_0 =
                            simulation_0.getSolution();

                    solution_0.clearSolution(Solution.Clear.History, Solution.Clear.Fields, Solution.Clear.LagrangianDem);

                    road_tunnel.getCorner1().setDefinition("[-${windtunnel_lengthToOutlet}, -${windtunnel_width}, 0.0]");

                } else if (windtunnel_type.equals("Cornering")) {
                    Solution solution_0 =
                            simulation_0.getSolution();

                    solution_0.clearSolution(Solution.Clear.History, Solution.Clear.Fields, Solution.Clear.LagrangianDem);

                    simulation_0.get(TagManager.class).setTags(road_tunnel, new NeoObjectVector(new Object[]{}));

                    simulation_0.get(TagManager.class).setTags(cornering_tunnel, new NeoObjectVector(new Object[]{userTag_0}));
                }
            } catch (Exception e) {
                erros += "Setting windtunnel failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Length Forward")) {
            try {
                windtunnel_length_forward = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("windtunnel_lengthToInlet"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(windtunnel_length_forward, units_1);
            } catch (Exception e) {
                erros += "Setting windtunnel length forward failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Length Backward")) {
            try {
                windtunnel_length_backward = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("windtunnel_lengthToOutlet"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(windtunnel_length_backward, units_1);
            } catch (Exception e) {
                erros += "Setting windtunnel length backward failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Width")) {
            try {
                windtunnel_width = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("windtunnel_width"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(windtunnel_width, units_1);
            } catch (Exception e) {
                erros += "Setting windtunnel width failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Heigth")) {
            try {
                windtunnel_height = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("windtunnel_height"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(windtunnel_height, units_1);
            } catch (Exception e) {
                erros += "Setting windtunnel heigth failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Outer Tunnel Radius Distance")) {
            try {
                cornering_outerradius = Double.parseDouble(value);
                CadModel cadModel_0 =
                        ((CadModel) simulation_0.get(SolidModelManager.class).getObject("Cornering"));

                ScalarQuantityDesignParameter scalarQuantityDesignParameter_0 =
                        ((ScalarQuantityDesignParameter) cadModel_0.getDesignParameterManager().getObject("Cornering_Delta_Outer_Radius"));

                scalarQuantityDesignParameter_0.getQuantity().setValueAndUnits(cornering_outerradius * 1000, units_mm);
            } catch (Exception e) {
                erros += "Setting outer tunnel radius distance failed \n";
            }

        } else if (name.equals("Vehicle State/Windtunnel/Inner Tunnel Radius Distance")) {
            try {
                cornering_innerradius = Double.parseDouble(value);
                CadModel cadModel_0 =
                        ((CadModel) simulation_0.get(SolidModelManager.class).getObject("Cornering"));

                ScalarQuantityDesignParameter scalarQuantityDesignParameter_0 =
                        ((ScalarQuantityDesignParameter) cadModel_0.getDesignParameterManager().getObject("Cornering_Delta_Inner_Radius"));

                scalarQuantityDesignParameter_0.getQuantity().setValueAndUnits(cornering_innerradius * 1000, units_mm);
            } catch (Exception e) {
                erros += "Setting inner tunnel radius distance failed \n";
            }
        } else if (name.equals("Vehicle State/Windtunnel/Cornering Radius")) {
            try {
                cornering_radius = Double.parseDouble(value);
                ScalarGlobalParameter scalarGlobalParameter_1 =
                        ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("cornering_radius"));
                scalarGlobalParameter_1.getQuantity().setValueAndUnits(cornering_radius * 1000, units_mm);
            } catch (Exception e) {
                erros += "Setting cornering radius failed \n";
            }
        }
        /*
        else if(name.equals("Vehicle State/Cooling/activated")) {
            //setCooling(Boolean.parseBoolean(value));

        }
        else if (name.equals("Vehicle State/Cooling/maxVolumeFlowRate[m^3 per h]")) {
            double volumeflowrate = Double.parseDouble(value);
            BoundaryInterface boundaryInterface_0 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

            FanCurvePolynomial fanCurvePolynomial_0 =
                    boundaryInterface_0.getValues().get(FanCurvePolynomial.class);

            FanCurvePolynomialLeaf fanCurvePolynomialLeaf_0 =
                    fanCurvePolynomial_0.getModelPartValue();

            Polynomial polynomial_0 =
                    fanCurvePolynomialLeaf_0.getPolynomial();

            polynomial_0.setIntervalRanges(new DoubleVector(new double[] {0.0, volumeflowrate}));
        } else if (name.equals("Vehicle State/Cooling/HX Position/X")) {
            hxPosX = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/HX Position/Y")) {
            hxPosY = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/HX Position/Z")) {
            hxPosZ = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/Fan Position/X")) {
            fanPosX = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/Fan Position/Y")) {
            fanPosY = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/Fan Position/Z")) {
            fanPosZ = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/HX Angle/X")) {
            hxAngleX = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/HX Angle/Y")) {
            hxAngleY = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/HX Angle/Z")) {
            hxAngleZ = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/Fan Angle/X")) {
            fanAngleX = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/Fan Angle/Y")) {
            fanAngleY = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/Fan Angle/Z")) {
            fanAngleZ = Double.parseDouble(value)*3.1415*2/360;
        } else if (name.equals("Vehicle State/Cooling/HX dimension/Width")) {
            hxWidth = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/HX dimension/Height")) {
            hxHeight = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/HX dimension/Thickness")) {
            hxThickness = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/Fan dimension/radius")) {
            fanRadius = Double.parseDouble(value);
        } else if (name.equals("Vehicle State/Cooling/Fan dimension/Thickness")) {
            fanThickness = Double.parseDouble(value);
        }

        else if (name.equals("Vehicle State/Cooling/fanDataRpm")) {

            double rpm = Double.parseDouble(value);

            BoundaryInterface boundaryInterface_0 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

            FanCurvePolynomial fanCurvePolynomial_0 =
                    boundaryInterface_0.getValues().get(FanCurvePolynomial.class);

            FanCurvePolynomialLeaf fanCurvePolynomialLeaf_0 =
                    fanCurvePolynomial_0.getModelPartValue();

            Units units_1 =
                    ((Units) simulation_0.getUnitsManager().getObject("rpm"));

            fanCurvePolynomialLeaf_0.getDataRotationRate().setValueAndUnits(rpm, units_1);

        } else if (name.equals("Vehicle State/Cooling/fanOperatingRpm")) {
            double rpm = Double.parseDouble(value);

            BoundaryInterface boundaryInterface_0 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

            FanCurvePolynomial fanCurvePolynomial_0 =
                    boundaryInterface_0.getValues().get(FanCurvePolynomial.class);

            FanCurvePolynomialLeaf fanCurvePolynomialLeaf_0 =
                    fanCurvePolynomial_0.getModelPartValue();

            Units units_1 =
                    ((Units) simulation_0.getUnitsManager().getObject("rpm"));

            fanCurvePolynomialLeaf_0.getOperatingRotationRate().setValueAndUnits(rpm, units_1);

        } else if (name.equals("Vehicle State/Cooling/Swirl")) {
            boolean eff = Boolean.parseBoolean(value);
            if(eff) {
                BoundaryInterface boundaryInterface_0 =
                        ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

                boundaryInterface_0.getConditions().get(AxialFanSwirlOption.class).setSelected(FanSwirlOption.Type.CALCULATED);
            }
            else
            {
                BoundaryInterface boundaryInterface_0 =
                        ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

                boundaryInterface_0.getConditions().get(AxialFanSwirlOption.class).setSelected(FanSwirlOption.Type.NO_SWIRL);
            }
        } else if (name.equals("Vehicle State/Cooling/Power")) {
            double power = Double.parseDouble(value);
            ScalarGlobalParameter scalarGlobalParameter_0 =
                    ((ScalarGlobalParameter) simulation_0.get(GlobalParameterManager.class).getObject("FanPower"));

            Units units_0 =
                    ((Units) simulation_0.getUnitsManager().getObject(""));

            scalarGlobalParameter_0.getQuantity().setValueAndUnits(power, units_0);
        }
         */
    }

    /*
    private void setPosCooling()
    {
        SimpleBlockPart simpleBlockPart_0 =
                ((SimpleBlockPart) simulation_0.get(SimulationPartManager.class).getPart("C_HeatExchanger"));

        Units units_3 =
                ((Units) simulation_0.getUnitsManager().getObject("mm"));

        simpleBlockPart_0.getCorner2().setCoordinate(units_3, units_3, units_3, new DoubleVector(new double[] {hxThickness, -hxWidth, hxHeight}));


        SimpleCylinderPart simpleCylinderPart_0 =
                ((SimpleCylinderPart) simulation_0.get(SimulationPartManager.class).getPart("z_MRF-Fan"));

        simpleCylinderPart_0.getEndCoordinate().setCoordinate(units_3, units_3, units_3, new DoubleVector(new double[] {fanThickness+1, 0.0, 0.0}));

        simpleCylinderPart_0.getRadius().setValueAndUnits(fanRadius, units_3);



        LabCoordinateSystem labCoordinateSystem_0 =
                simulation_0.getCoordinateSystemManager().getLabCoordinateSystem();

        CartesianCoordinateSystem cartesianCoordinateSystem_0 =
                ((CartesianCoordinateSystem) labCoordinateSystem_0.getLocalCoordinateSystemManager().getObject("HeatExchanger"));

        cartesianCoordinateSystem_0.getOrigin().setCoordinate(units_3, units_3, units_3, new DoubleVector(new double[] {hxPosX, -hxPosY, hxPosZ}));

        CartesianCoordinateSystem cartesianCoordinateSystem_1 =
                ((CartesianCoordinateSystem) labCoordinateSystem_0.getLocalCoordinateSystemManager().getObject("Fan"));

        cartesianCoordinateSystem_1.getOrigin().setCoordinate(units_3, units_3, units_3, new DoubleVector(new double[] {fanPosX, -fanPosY, fanPosZ}));


        Units units_2 =
                ((Units) simulation_0.getUnitsManager().getObject(""));


        //cartesianCoordinateSystem_1.getXVector().setComponentsAndUnits(Math.cos(fanAngleZ)*Math.cos(fanAngleY), Math.sin(fanAngleZ)*Math.cos(fanAngleY), -Math.sin(fanAngleY), units_2);


        //cartesianCoordinateSystem_0.getXVector().setComponentsAndUnits(Math.cos(hxAngleZ)*Math.cos(hxAngleY), Math.sin(hxAngleZ)*Math.cos(hxAngleY), -Math.sin(hxAngleY), units_2);


        cartesianCoordinateSystem_1.getXVector().setComponentsAndUnits(Math.cos(-fanAngleZ)*Math.cos(fanAngleY), Math.sin(-fanAngleZ)*Math.cos(fanAngleY), -Math.sin(fanAngleY), units_2);


        cartesianCoordinateSystem_0.getXVector().setComponentsAndUnits(Math.cos(-hxAngleZ)*Math.cos(hxAngleY), Math.sin(-hxAngleZ)*Math.cos(hxAngleY), -Math.sin(hxAngleY), units_2);




    }

    private void setCooling(boolean on) {

        Simulation simulation_0 =
                getActiveSimulation();

        PhysicsContinuum physicsContinuum_0 =
                ((PhysicsContinuum) simulation_0.getContinuumManager().getContinuum("k-omegaSST"));

        Region region_0 =
                simulation_0.getRegionManager().getRegion("HX");

        SimpleCylinderPart simpleCylinderPart_0 =
                ((SimpleCylinderPart) simulation_0.get(SimulationPartManager.class).getPart("C_FanCyl"));


        SimpleBlockPart simpleBlockPart_1 =
                ((SimpleBlockPart) simulation_0.get(SimulationPartManager.class).getPart("C_HeatExchanger"));


        AutoMeshOperation autoMeshOperation_0 =
                ((AutoMeshOperation) simulation_0.get(MeshOperationManager.class).getObject("air"));


        MeshOperationPart meshOperationPart_0 =
                ((MeshOperationPart) simulation_0.get(SimulationPartManager.class).getPart("A_Air"));


        autoMeshOperation_0.getInputGeometryObjects().setQuery(null);



        try
        {
            BoundaryInterface boundaryInterface_0 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("HX_in"));

            simulation_0.getInterfaceManager().remove(boundaryInterface_0);

            BoundaryInterface boundaryInterface_1 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("HX_out"));

            simulation_0.getInterfaceManager().remove(boundaryInterface_1);

        }
        catch (Exception ignored)
        {

        }





        if(on)
        {
            physicsContinuum_0.add(region_0);

            UserTag userTag_0 =
                    ((UserTag) simulation_0.get(TagManager.class).getObject("Wrapper"));

            autoMeshOperation_0.getInputGeometryObjects().setObjects(meshOperationPart_0, simpleCylinderPart_0);


            simulation_0.get(TagManager.class).setTags(simpleCylinderPart_0, new ArrayList<>(Arrays.<Tag>asList(userTag_0)));


            simulation_0.get(TagManager.class).setTags(simpleBlockPart_1, new ArrayList<>(Arrays.<Tag>asList(userTag_0)));


            Region region_1 =
                    simulation_0.getRegionManager().getRegion("Air");

            Boundary boundary_0 =
                    region_1.getBoundaryManager().getBoundary("HX_inlet");


            Boundary boundary_1 =
                    region_0.getBoundaryManager().getBoundary("inlet");

            BoundaryInterface boundaryInterface_2 =
                    simulation_0.getInterfaceManager().createBoundaryInterface(boundary_0, boundary_1, "Interface");

            Boundary boundary_2 =
                    region_1.getBoundaryManager().getBoundary("HX_outlet");

            Boundary boundary_3 =
                    region_0.getBoundaryManager().getBoundary("outlet");

            BoundaryInterface boundaryInterface_3 =
                    simulation_0.getInterfaceManager().createBoundaryInterface(boundary_2, boundary_3, "Interface");

            boundaryInterface_2.setPresentationName("HX_in");

            boundaryInterface_3.setPresentationName("HX_out");

            MassFlowReport massFlowReport_0 =
                    ((MassFlowReport) simulation_0.getReportManager().getReport("Mass Flow HX"));

            massFlowReport_0.getParts().setQuery(null);

            InterfaceBoundary interfaceBoundary_0 =
                    ((InterfaceBoundary) region_0.getBoundaryManager().getBoundary("outlet [HX_out]"));

            massFlowReport_0.getParts().setObjects(interfaceBoundary_0);



            setFanCurvePoly();

        }
        else {
            physicsContinuum_0.erase(region_0);

            simulation_0.get(TagManager.class).setTags(simpleCylinderPart_0, new ArrayList<>(Collections.<Tag>emptyList()));


            simulation_0.get(TagManager.class).setTags(simpleBlockPart_1, new ArrayList<>(Collections.<Tag>emptyList()));

            autoMeshOperation_0.getInputGeometryObjects().setObjects(meshOperationPart_0);





        }

    }

    private void setFanCurvePoly()
    {
        try {
            BufferedReader br = new BufferedReader(new FileReader("fan_curve_poly.csv"));
            String line = br.readLine();
            String[] coefsS = line.split(",");
            double[] coefs = new double[coefsS.length];
            double[] expos = new double[coefsS.length];
            for(int i = 0; i < coefsS.length; i++)
            {
                coefs[i] = Double.parseDouble(coefsS[i]);
                expos[i] = i;
            }

            BoundaryInterface boundaryInterface_0 =
                    ((BoundaryInterface) simulation_0.getInterfaceManager().getInterface("Fan_out"));

            FanCurvePolynomial fanCurvePolynomial_0 =
                    boundaryInterface_0.getValues().get(FanCurvePolynomial.class);

            FanCurvePolynomialLeaf fanCurvePolynomialLeaf_0 =
                    fanCurvePolynomial_0.getModelPartValue();

            Polynomial polynomial_0 =
                    fanCurvePolynomialLeaf_0.getPolynomial();


            polynomial_0.setNumberOfCoefficients(new IntVector(new int[] {coefs.length}));

            polynomial_0.setCoefficients(new DoubleVector(coefs));

            polynomial_0.setExponents(new DoubleVector(expos));

            fanCurvePolynomialLeaf_0.getFanCurvePressureRiseOption().setSelected(FanCurvePressureRiseOption.Type.STANDARD);





        } catch (FileNotFoundException e) {
            throw new RuntimeException(e);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

    }
     */
    private void startMeshing() {

        MeshPipelineController meshPipelineController_0 =
                simulation_0.get(MeshPipelineController.class);


        try {
            SimpleAnnotation simpleAnnotation_0 =
                    ((SimpleAnnotation) simulation_0.getAnnotationManager().getObject("simulation name"));
            String simulation_name = new File(directory).getName();
            simpleAnnotation_0.setText(simulation_name);
        } catch (Exception e) {
            erros += "Setting annotation failed \n";
        }


        meshPipelineController_0.generateVolumeMesh();

        String FileName = simulation_0.getPresentationName();

        simulation_0.saveState(resolvePath(FileName + ".sim"));

        // Marker for the job script: only now is there a saved volume mesh (a failed meshing throws before).
        try {
            new File(directory + slash + "MESHED").createNewFile();
        } catch (IOException e) {
            erros += "Writing MESHED failed\n";
        }


    }


    // A part group (composite part) by name, or null when the simulation has none.
    private SolidModelCompositePart group(String name) {
        try {
            return (SolidModelCompositePart) simulation_0.get(SimulationPartManager.class).getPart(name);
        } catch (Exception e) {
            return null;
        }
    }

    // The part group a CAD file replaces, from its name (case ignored): frontwing or FW, undertray or UT,
    // deflector, mono, rearwing or RW; anything else is added to z_000_remaining-parts ("replace" in the name: replaces that group). FW, UT and RW count
    // as separate words only (e.g. "FW_V1.stp", "1008_RW_V4.step").
    private String groupName(String fileName) {
        String name = fileName.toLowerCase(java.util.Locale.ROOT);
        if (name.lastIndexOf('.') > 0) {
            name = name.substring(0, name.lastIndexOf('.'));
        }
        java.util.List<String> words = Arrays.asList(name.split("[^a-z0-9]+"));
        if (name.contains("frontwing") || name.contains("front_wing") || words.contains("fw")) return "C_FRONTWING";
        if (name.contains("deflector")) return "C_UNDERTRAY_DEFLECTORS";
        if (name.contains("undertray") || words.contains("ut")) return "C_UNDERTRAY";
        if (name.contains("mono")) return "C_MONOCOQUE";
        if (name.contains("rearwing") || name.contains("rear_wing") || words.contains("rw")) return "C_REARWING";
        return "z_000_remaining-parts";
    }

    // CAD files (.stp, .step, .igs, .iges, .stl) in the case folder, in name order. Each file is imported, every
    // part the import creates (one, or many for an assembly) goes into the file's part group, and the group's old
    // parts are removed first (only once per group, so several files can fill one group). A file that fails is
    // skipped with the reason in ERRORS and the log; the old parts of its group then stay.
    private void addCAD() {
        File[] files = new File(directory).listFiles();
        if (files == null) {
            return;
        }
        Arrays.sort(files);
        SimulationPartManager parts = simulation_0.get(SimulationPartManager.class);
        java.util.Set<String> replaced = new java.util.HashSet<>();
        for (File file : files) {
            String lower = file.getName().toLowerCase(java.util.Locale.ROOT);
            if (!file.isFile() || !(lower.endsWith(".igs") || lower.endsWith(".iges") || lower.endsWith(".step") || lower.endsWith(".stp") || lower.endsWith(".stl"))) {
                continue;
            }
            String groupName = groupName(file.getName());
            try {
                SolidModelCompositePart target = group(groupName);
                if (target == null) {
                    throw new IllegalStateException("the simulation has no part group " + groupName);
                }
                java.util.Set<GeometryPart> before = new java.util.HashSet<>(parts.getParts());
                PartImportManager partImportManager_0 = simulation_0.get(PartImportManager.class);
                if (lower.endsWith(".stl")) {
                    // STAR-CCM+'s own STL reader (needs no CAD Exchange licence); STL files are in millimetres.
                    partImportManager_0.importStlPart(resolvePath(file.getPath()), "OneSurfacePerPatch", units_mm, true, 1.0E-5);
                } else {
                    partImportManager_0.importCadPart(resolvePath(file.getPath()), "SharpEdges", 30.0, 5, true, 1.0E-5, true, false, false, false, true, NeoProperty.fromString("{\'NX\': 1, \'STEP\': 1, \'SE\': 1, \'CGR\': 1, \'SW\': 1, \'IFC\': 1, \'ACIS\': 1, \'JT\': 1, \'IGES\': 1, \'CATIAV5\': 1, \'CATIAV4\': 1, \'3DXML\': 1, \'CREO\': 1, \'INV\': 1}"), true, false);
                }
                java.util.List<GeometryPart> added = new java.util.ArrayList<>(parts.getParts());
                added.removeAll(before);
                if (added.isEmpty()) {
                    throw new IllegalStateException("the import created no parts");
                }
                int removed = 0;
                // Files for the remaining-parts group are added to it, except files whose name contains "replace"
                // (e.g. remaining_replace_r0.stl): those replace the whole group, as for the other groups.
                boolean replaceGroup = target != remaining || lower.contains("replace");
                if (replaceGroup && replaced.add(groupName)) {
                    Collection<GeometryPart> old = new java.util.ArrayList<>(target.getChildParts().getParts());
                    removed = old.size();
                    target.getPartManager().removeParts(old);
                }
                parts.reparentParts(added, target.getChildParts());
                simulation_0.println("addCAD: " + file.getName() + " -> " + groupName + ": " + added.size() + " part(s) imported, " + removed + " old part(s) removed");
                for (GeometryPart part : target.getChildParts().getParts()) {
                    simulation_0.println("addCAD:   " + groupName + " contains " + part.getPresentationName() + " ["
                            + part.getClass().getSimpleName() + ", " + part.getPartSurfaces().size() + " surface(s)]");
                }
            } catch (Exception e) {
                String reason = file.getName() + " (" + groupName + ") not imported: " + e.getMessage();
                erros += "Adding CAD: " + reason + "\n";
                simulation_0.println("addCAD: " + reason);
            }
        }
    }

    private void writeErrors() {

        File errorFile = new File(simulation_0.getSessionDir() + slash + "ERRORS");
        if(!erros.equals("")) {
            try {
                BufferedWriter bw = new BufferedWriter(new FileWriter(errorFile));
                bw.write(erros);
                bw.close();
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }

    }


}
